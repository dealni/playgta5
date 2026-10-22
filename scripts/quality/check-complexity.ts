#!/usr/bin/env node
/**
 * Ratchet AST de tamanho e complexidade: mede fontes novas por varredura,
 * exclui testes e conta funções aninhadas separadamente. Recusa aumento dos
 * máximos, da dívida por arquivo/função e da quantidade acima dos limiares,
 * além de redução do escopo. `check:size` continua sendo orçamento de bundle.
 * Melhoras atualizam o baseline local; CI só lê. Regravação de dívida exige
 * `npm run complexity:baseline` explícito, fora de CI, e revisão do diff.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  ehPasta,
  listarEntradas,
  nomeDaEntrada,
  type Listar,
} from "../comum/arvore.ts";
import { relatarPortao } from "../comum/portao.ts";

// ---- Dados deste repositório ----

/*
 * Contrato do bloco: o código comum abaixo dele só conhece `ALVOS`,
 * `IGNORAR_PASTAS` (nome de pasta em que a varredura não entra, em qualquer
 * profundidade), `FONTES` (as extensões que contam como código aqui),
 * `LIMITE_LINHAS`, `LIMITE_COMPLEXIDADE` e o predicado
 * `dentroDoRecorte(relativo, alvo)`, que recebe o caminho relativo à raiz de
 * cada arquivo de fonte já filtrado pelo piso comum e decide se ele é medido.
 */

/**
 * Escopo próprio deste repositório; testes, gerados e vendor saem pelo piso comum.
 * Os scripts incluídos implementam o cliente/runtime distribuído ao usuário.
 */
const ALVOS = ["support", "hosting"];

const IGNORAR_PASTAS = new Set(["node_modules"]);

/** Extensões das fontes próprias; declarações, testes e gerados são excluídos. */
const FONTES = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/**
 * Caminhos, relativos à raiz, que ficam fora da medição. Teste, `.d.ts`,
 * gerado, vendorizado e mock já saem pelo piso comum, logo abaixo do bloco;
 * aqui entra só o que é desta árvore.
 */
const IGNORAR_CAMINHOS: readonly RegExp[] = [];

/**
 * A partir daqui um arquivo é "grande" e uma função é "complexa". Não são
 * tetos: são as faixas cujo TAMANHO o ratchet não deixa crescer. A política
 * usa 500 linhas físicas por arquivo e complexidade ciclomática 15 por função. Este gate AST é a autoridade de tamanho/complexidade do produto;
 * não há teto ESLint paralelo com outra forma de contar decisões.
 */
export const LIMITE_LINHAS = 500;
export const LIMITE_COMPLEXIDADE = 15;

/** Tudo dentro dos alvos é produto, menos o que a lista acima recusa. */
export const dentroDoRecorte: (relativo: string, alvo: string) => boolean = (
  relativo,
) => !IGNORAR_CAMINHOS.some((padrao) => padrao.test(relativo));

// ---- Fim dos dados deste repositório ----

/** Seção exclusiva do ratchet de tamanho e complexidade dentro do baseline. */
export const SECAO = "tamanho";

const RAIZ = fileURLToPath(new URL("../..", import.meta.url));

/** Piso comum: exclui testes, declarações, código gerado e vendorizado. */
const EXCLUIDOS_COMUNS: readonly RegExp[] = [
  /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u,
  /\.d\.[cm]?ts$/u,
  /\/generated\//u,
  /\/vendor\//u,
  /\/__tests__\//u,
  /\/__mocks__\//u,
];

export type Funcao = {
  readonly caminho: string;
  readonly nome: string;
  readonly identidade?: string;
  readonly linha: number;
  readonly complexidade: number;
};

export type Arquivo = { readonly caminho: string; readonly linhas: number };

export type Medicao = {
  readonly por_arquivo: Readonly<Record<string, number>>;
  readonly por_funcao: Readonly<Record<string, readonly number[]>>;
  readonly arquivos: number;
  readonly linhas: number;
  readonly maior_arquivo: Arquivo;
  readonly arquivos_grandes: number;
  readonly funcoes: number;
  readonly maior_funcao: Funcao;
  readonly funcoes_complexas: number;
};

const ehFonte = (nome: string, relativo: string): boolean =>
  FONTES.test(nome) &&
  !EXCLUIDOS_COMUNS.some((padrao) => padrao.test(relativo));

/** Os arquivos medidos, em caminho relativo à raiz. */
export function descobrirFontes(
  raiz: string = RAIZ,
  alvos: readonly string[] = ALVOS,
  listar: Listar = listarEntradas,
): readonly string[] {
  const achados: string[] = [];
  for (const alvo of alvos) {
    const pilha = [join(raiz, alvo)];
    while (pilha.length > 0) {
      const atual = pilha.pop();
      if (atual === undefined) break;
      let entradas: readonly string[];
      try {
        entradas = listar(atual);
      } catch {
        continue;
      }
      for (const entrada of entradas) {
        const nome = nomeDaEntrada(entrada);
        const caminho = join(atual, nome);
        if (ehPasta(entrada)) {
          if (!IGNORAR_PASTAS.has(nome)) pilha.push(caminho);
          continue;
        }
        const relativo = relative(raiz, caminho).replace(/\\/gu, "/");
        if (ehFonte(nome, relativo) && dentroDoRecorte(relativo, alvo)) {
          achados.push(relativo);
        }
      }
    }
  }
  return achados.sort();
}

const RAMOS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);

/**
 * `case` entra e `default` não: `default` não cria caminho novo, é o caminho
 * que já existia. `&&`, `||` e `??` entram porque são desvio de fluxo — a
 * diferença para um `if` é sintática, não de caminho executado.
 */
const OPERADORES = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const ehFuncao = (no: ts.Node): boolean =>
  ts.isFunctionDeclaration(no) ||
  ts.isFunctionExpression(no) ||
  ts.isArrowFunction(no) ||
  ts.isMethodDeclaration(no) ||
  ts.isConstructorDeclaration(no) ||
  ts.isGetAccessor(no) ||
  ts.isSetAccessor(no);

/** Um ponto de decisão a mais, um caminho a mais para testar. */
function pontosDeDecisao(no: ts.Node): number {
  if (RAMOS.has(no.kind)) return 1;
  return ts.isBinaryExpression(no) && OPERADORES.has(no.operatorToken.kind)
    ? 1
    : 0;
}

/** Complexidade por função: funções aninhadas são medidas separadamente. */
export function complexidadeDe(funcao: ts.Node): number {
  let total = 1;
  const visitar = (no: ts.Node): void => {
    if (no !== funcao && ehFuncao(no)) return;
    total += pontosDeDecisao(no);
    ts.forEachChild(no, visitar);
  };
  ts.forEachChild(funcao, visitar);
  return total;
}

function nomeDe(no: ts.Node): string {
  const nomeado = no as { readonly name?: ts.Node };
  if (nomeado.name !== undefined && ts.isIdentifier(nomeado.name)) {
    return nomeado.name.text;
  }
  const pai = no.parent as ts.Node | undefined;
  if (
    pai !== undefined &&
    ts.isVariableDeclaration(pai) &&
    ts.isIdentifier(pai.name)
  ) {
    return pai.name.text;
  }
  if (
    pai !== undefined &&
    ts.isPropertyAssignment(pai) &&
    ts.isIdentifier(pai.name)
  ) {
    return pai.name.text;
  }
  return nomeado.name?.getText().replace(/\s+/gu, "") ?? "<anônima>";
}

/** Identidade lexical, independente de linhas, formatação e corpo da função. */
function segmentoDe(no: ts.Node): string {
  const nome = nomeDe(no);
  if (nome !== "<anônima>") return `${ts.SyntaxKind[no.kind]}:${nome}`;
  const pai = no.parent;
  if (ts.isCallExpression(pai)) {
    return `callback:${calleeDe(pai.expression)}:${pai.arguments.indexOf(no as ts.Expression)}`;
  }
  if (ts.isConstructorDeclaration(no)) return "constructor";
  return ts.SyntaxKind[no.kind];
}

function elementoAncora(no: ts.Node): boolean {
  return (
    ts.isIdentifier(no) ||
    ts.isStringLiteral(no) ||
    ts.isNumericLiteral(no) ||
    (ts.isPropertyAccessExpression(no) && elementoAncora(no.expression))
  );
}

/** Só o alvo lexical: chamadas anteriores nunca carregam seus argumentos. */
function calleeDe(no: ts.Expression): string {
  if (ts.isIdentifier(no) || ts.isPrivateIdentifier(no)) return no.text;
  if (ts.isPropertyAccessExpression(no))
    return `${calleeDe(no.expression)}.${no.name.text}`;
  if (ts.isElementAccessExpression(no))
    return `${calleeDe(no.expression)}[${calleeDe(no.argumentExpression)}]`;
  if (ts.isCallExpression(no) || ts.isNewExpression(no))
    return `${calleeDe(no.expression)}()`;
  return alvoAtomico(no);
}

function alvoAtomico(no: ts.Expression): string {
  if (
    ts.isParenthesizedExpression(no) ||
    ts.isAsExpression(no) ||
    ts.isTypeAssertionExpression(no) ||
    ts.isNonNullExpression(no) ||
    ts.isSatisfiesExpression(no)
  )
    return calleeDe(no.expression);
  if (ts.isStringLiteral(no)) return JSON.stringify(no.text);
  if (ts.isNumericLiteral(no)) return no.text;
  if (no.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (no.kind === ts.SyntaxKind.SuperKeyword) return "super";
  return `<${ts.SyntaxKind[no.kind]}>`;
}

function ancoraDeChamada(no: ts.CallExpression): string {
  const literais = no.arguments
    .filter(
      (arg) =>
        ts.isStringLiteral(arg) ||
        ts.isNumericLiteral(arg) ||
        (ts.isArrayLiteralExpression(arg) &&
          arg.elements.every(elementoAncora)),
    )
    .map((arg) =>
      ts.isStringLiteral(arg)
        ? JSON.stringify(arg.text)
        : ts.isArrayLiteralExpression(arg)
          ? `[${arg.elements.map((elemento) => calleeDe(elemento)).join(",")}]`
          : calleeDe(arg),
    );
  return `chamada:${calleeDe(no.expression)}:${literais.join(",")}`;
}

export function identidadeDe(no: ts.Node): string {
  const partes = [segmentoDe(no)];
  let pai: ts.Node | undefined = no.parent;
  while (pai !== undefined && !ts.isSourceFile(pai)) {
    if (ehFuncao(pai)) partes.unshift(segmentoDe(pai));
    else if (ts.isCallExpression(pai)) partes.unshift(ancoraDeChamada(pai));
    else if (
      ts.isClassDeclaration(pai) ||
      ts.isClassExpression(pai) ||
      ts.isVariableDeclaration(pai) ||
      ts.isPropertyAssignment(pai)
    ) {
      partes.unshift(pai.name?.getText().replace(/\s+/gu, "") ?? "<classe>");
    }
    pai = pai.parent;
  }
  return partes.join("/");
}

/** Todas as funções de um arquivo, com a complexidade de cada uma. */
export function funcoesDoArquivo(
  caminho: string,
  conteudo: string,
): readonly Funcao[] {
  const fonte = ts.createSourceFile(
    caminho,
    conteudo,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/u.test(caminho) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const funcoes: Funcao[] = [];
  const visitar = (no: ts.Node): void => {
    if (ehFuncao(no)) {
      funcoes.push({
        caminho,
        nome: nomeDe(no),
        identidade: identidadeDe(no),
        linha: fonte.getLineAndCharacterOfPosition(no.getStart(fonte)).line + 1,
        complexidade: complexidadeDe(no),
      });
    }
    ts.forEachChild(no, visitar);
  };
  ts.forEachChild(fonte, visitar);
  return funcoes;
}

/** Linhas do arquivo, contadas como um editor conta: a última sem `\n` conta. */
export function contarLinhas(conteudo: string): number {
  if (conteudo === "") return 0;
  const linhas = conteudo.split("\n");
  return linhas.at(-1) === "" ? linhas.length - 1 : linhas.length;
}

const VAZIO_ARQUIVO: Arquivo = { caminho: "—", linhas: 0 };
const VAZIA_FUNCAO: Funcao = {
  caminho: "—",
  nome: "—",
  linha: 0,
  complexidade: 0,
};

export function medir(
  arquivos: readonly string[],
  ler: (caminho: string) => string,
): Medicao {
  // Um ratchet sobre zero arquivo aprova qualquer coisa para sempre, e é o que
  // acontece quando um ALVO é renomeado sem ninguém notar.
  if (arquivos.length === 0) {
    throw new Error("Nenhum arquivo para medir: a lista chegou vazia.");
  }

  const porArquivo: Record<string, number> = {};
  const porFuncao: Record<string, number[]> = {};
  const identidades: Record<string, number> = {};
  let maiorArquivo = VAZIO_ARQUIVO;
  let maiorFuncao = VAZIA_FUNCAO;
  let linhas = 0;
  let grandes = 0;
  let complexas = 0;
  let total = 0;

  for (const caminho of arquivos) {
    const conteudo = ler(caminho);
    const doArquivo = contarLinhas(conteudo);
    linhas += doArquivo;
    if (doArquivo > maiorArquivo.linhas) {
      maiorArquivo = { caminho, linhas: doArquivo };
    }
    if (doArquivo > LIMITE_LINHAS) {
      grandes += 1;
      porArquivo[caminho] = doArquivo;
    }
    for (const funcao of funcoesDoArquivo(caminho, conteudo)) {
      contarIdentidade(identidades, funcao);
      registrarFuncao(porFuncao, funcao);
      total += 1;
      if (funcao.complexidade > maiorFuncao.complexidade) maiorFuncao = funcao;
      if (funcao.complexidade > LIMITE_COMPLEXIDADE) complexas += 1;
    }
  }

  exigirIdentidadesUnicas(porFuncao, identidades);
  return {
    por_arquivo: porArquivo,
    por_funcao: Object.fromEntries(
      Object.entries(porFuncao).sort(([a], [b]) => a.localeCompare(b)),
    ),
    arquivos: arquivos.length,
    linhas,
    maior_arquivo: maiorArquivo,
    arquivos_grandes: grandes,
    funcoes: total,
    maior_funcao: maiorFuncao,
    funcoes_complexas: complexas,
  };
}

const CAMINHO_BASELINE = join(RAIZ, "tools/quality/tamanho-baseline.json");

export function baselineEhSomenteLeitura(
  // Não use `NodeJS.ProcessEnv`: é interface global e o Next a aumenta com
  // `NODE_ENV` OBRIGATÓRIO, o que faz o literal `{ CI: "true" }` do teste não
  // compilar em repositório Next.
  ambiente: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const ci = ambiente.CI;
  return typeof ci === "string" && ci !== "" && ci !== "0" && ci !== "false";
}

function escopoEncolheu(medido: number, referencia: number): boolean {
  if (medido < 0 || referencia < 0)
    throw new Error("Escopo de baseline inválido.");
  return medido < referencia;
}

export function lerBaseline(
  caminho = CAMINHO_BASELINE,
): Readonly<Record<string, unknown>> {
  if (!existsSync(caminho)) return {};
  let dados: unknown;
  try {
    dados = JSON.parse(readFileSync(caminho, "utf8"));
  } catch {
    throw new Error(`${caminho} não é JSON válido.`);
  }
  if (typeof dados !== "object" || dados === null || Array.isArray(dados)) {
    throw new Error(`${caminho} não contém um objeto.`);
  }
  return dados as Readonly<Record<string, unknown>>;
}

export function gravarSecao(
  chave: string,
  secao: Readonly<Record<string, unknown>>,
  caminho = CAMINHO_BASELINE,
): void {
  if (chave !== SECAO)
    throw new Error("O ratchet grava apenas tamanho e complexidade.");
  const dados = {
    _leia:
      "Escrito por scripts/quality/check-complexity.ts. Somente tamanho e " +
      "complexidade. Regrave com `npm run complexity:baseline`, não edite à mão.",
    [SECAO]: {
      // Os limiares ficam gravados junto porque as contagens só significam
      // alguma coisa em relação a eles: mudar o limiar sem regravar compararia
      // números medidos com réguas diferentes.
      limiares: { linhas: LIMITE_LINHAS, complexidade: LIMITE_COMPLEXIDADE },
      ...secao,
      medido_em: new Date().toISOString().slice(0, 10),
    },
  };
  writeFileSync(caminho, `${JSON.stringify(dados, null, 2)}\n`);
}

const numero = (valor: unknown, rotulo: string): number => {
  if (typeof valor !== "number" || !Number.isFinite(valor)) {
    throw new Error(
      `tamanho-baseline.json: seção '${SECAO}' sem '${rotulo}'. ` +
        "Regrave com `npm run complexity:baseline`.",
    );
  }
  return valor;
};

/**
 * A seção do ratchet dentro do arquivo lido.
 *
 * Arquivo inexistente é a primeira medição, e ela VIRA o baseline. Arquivo que
 * existe SEM a seção é outra coisa: alguém apagou a seção à mão, ou o formato
 * mudou debaixo do portão. Tratar os dois casos igual faria o ratchet
 * recomeçar do zero e aprovar a árvore inteira em silêncio, que é exatamente o
 * que ele existe para não fazer.
 */
export function secaoExigida(
  dados: Readonly<Record<string, unknown>>,
): unknown {
  if (Object.keys(dados).length === 0) return null;
  const secao = dados[SECAO];
  if (secao === undefined) {
    throw new Error(
      `tools/quality/tamanho-baseline.json existe, mas não tem a seção '${SECAO}'. ` +
        "Sem ela o ratchet recomeçaria do zero; se a regravação for de " +
        "propósito, peça-a com `npm run complexity:baseline`.",
    );
  }
  return secao;
}

export type Veredito = {
  readonly problemas: readonly string[];
  readonly melhorou: boolean;
};

/**
 * O veredito, sem I/O. São DOIS sentidos: os quatro números de tamanho só
 * andam para baixo, e o ESCOPO medido (arquivos e funções) só anda para cima.
 * A ordem importa — escopo primeiro, número depois: sem o segundo sentido,
 * tirar metade da árvore da medição apareceria como melhoria.
 */
function contarIdentidade(
  contagens: Record<string, number>,
  funcao: Funcao,
): void {
  const chave = JSON.stringify([funcao.caminho, funcao.identidade]);
  contagens[chave] = (contagens[chave] ?? 0) + 1;
}

function exigirIdentidadesUnicas(
  caps: Record<string, number[]>,
  contagens: Record<string, number>,
): void {
  for (const chave of Object.keys(caps)) {
    if ((contagens[chave] ?? 0) > 1)
      throw new Error(
        `Identidade ambígua acima do limite: ${chave}. Nomeie a função ou forneça âncora lexical distinta; cap não pode ser compartilhado.`,
      );
  }
}

/** Caps individuais exigem uma identidade lexical única para cada função complexa. */
function registrarFuncao(caps: Record<string, number[]>, funcao: Funcao): void {
  if (funcao.complexidade <= LIMITE_COMPLEXIDADE) return;
  const chave = JSON.stringify([funcao.caminho, funcao.identidade]);
  (caps[chave] ??= []).push(funcao.complexidade);
  caps[chave]?.sort((a, b) => b - a);
}

function inventarioExigido(
  valor: unknown,
  rotulo: string,
): Record<string, unknown> {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) {
    throw new Error(
      `Baseline sem inventário ${rotulo}; migração exige revisão explícita, não regravação automática.`,
    );
  }
  return valor as Record<string, unknown>;
}

function capsExigidos(valor: unknown): readonly number[] {
  if (!Array.isArray(valor) || valor.length !== 1)
    throw new Error("Caps de função inválidos.");
  const caps = valor.map((cap: unknown) => numero(cap, "cap individual"));
  if (
    caps.some((cap) => !Number.isInteger(cap) || cap <= LIMITE_COMPLEXIDADE)
  ) {
    throw new Error("Cap individual de função fora da faixa.");
  }
  return caps.sort((a, b) => b - a);
}

function compararArquivos(
  medido: Medicao,
  referencia: Record<string, unknown>,
): string[] {
  const problemas: string[] = [];
  for (const [caminho, linhas] of Object.entries(medido.por_arquivo)) {
    const cap =
      referencia[caminho] === undefined
        ? LIMITE_LINHAS
        : numero(referencia[caminho], caminho);
    if (linhas > cap)
      problemas.push(
        `arquivo ${caminho}: ${cap} → ${linhas} linhas; cap individual excedido.`,
      );
  }
  return problemas;
}

function compararFuncoes(
  medido: Medicao,
  referencia: Record<string, unknown>,
): string[] {
  const problemas: string[] = [];
  for (const [identidade, complexidades] of Object.entries(medido.por_funcao)) {
    const caps =
      referencia[identidade] === undefined
        ? []
        : capsExigidos(referencia[identidade]);
    complexidades.forEach((complexidade, indice) => {
      const deslocamento = Math.max(0, caps.length - complexidades.length);
      const cap = caps[indice + deslocamento] ?? LIMITE_COMPLEXIDADE;
      if (complexidade > cap)
        problemas.push(
          `função ${identidade}: ${cap} → ${complexidade}; cap individual excedido.`,
        );
    });
  }
  return problemas;
}

function compararIndividuais(
  medido: Medicao,
  anterior: Record<string, unknown>,
): string[] {
  return [
    ...compararArquivos(
      medido,
      inventarioExigido(anterior.por_arquivo, "por_arquivo"),
    ),
    ...compararFuncoes(
      medido,
      inventarioExigido(anterior.por_funcao, "por_funcao"),
    ),
  ];
}

function individuaisMudaram(
  medido: Medicao,
  anterior: Record<string, unknown>,
): boolean {
  return (
    JSON.stringify(medido.por_arquivo) !==
      JSON.stringify(anterior.por_arquivo) ||
    JSON.stringify(medido.por_funcao) !== JSON.stringify(anterior.por_funcao)
  );
}

export function avaliar(medido: Medicao, baseline: unknown): Veredito {
  if (baseline === null || typeof baseline !== "object") {
    return { problemas: [], melhorou: true };
  }
  const anterior = baseline as Readonly<Record<string, unknown>>;
  const problemas = compararIndividuais(medido, anterior);

  const arquivosAntes = numero(anterior.arquivos, "arquivos");
  if (escopoEncolheu(medido.arquivos, arquivosAntes)) {
    problemas.push(
      `o escopo medido encolheu (${arquivosAntes} → ${medido.arquivos} arquivos). ` +
        "Placar melhor sobre menos código não é ganho; se a remoção foi de propósito, " +
        "regrave com `npm run complexity:baseline`.",
    );
  }

  const funcoesAntes = numero(anterior.funcoes, "funcoes");
  if (escopoEncolheu(medido.funcoes, funcoesAntes)) {
    problemas.push(
      `o escopo medido encolheu (${funcoesAntes} → ${medido.funcoes} funções). ` +
        "Regrave de propósito com `npm run complexity:baseline` se o código saiu mesmo.",
    );
  }

  const maiorArquivo = referenciaDeArquivo(anterior.maior_arquivo);
  if (medido.maior_arquivo.linhas > maiorArquivo) {
    problemas.push(
      `o maior arquivo passou de ${maiorArquivo} para ${medido.maior_arquivo.linhas} linhas ` +
        `(${medido.maior_arquivo.caminho}). Quebre o arquivo; o ratchet só desce.`,
    );
  }

  const maiorFuncao = referenciaDeFuncao(anterior.maior_funcao);
  if (medido.maior_funcao.complexidade > maiorFuncao) {
    problemas.push(
      `a função mais complexa passou de ${maiorFuncao} para ${medido.maior_funcao.complexidade} ` +
        `(${medido.maior_funcao.caminho}:${medido.maior_funcao.linha}, \`${medido.maior_funcao.nome}\`). ` +
        "Extraia a decisão; o ratchet só desce.",
    );
  }

  const grandesAntes = numero(anterior.arquivos_grandes, "arquivos_grandes");
  const complexasAntes = numero(
    anterior.funcoes_complexas,
    "funcoes_complexas",
  );
  for (const [rotulo, base, agora, limite] of [
    [
      `arquivos acima de ${LIMITE_LINHAS} linhas`,
      grandesAntes,
      medido.arquivos_grandes,
      LIMITE_LINHAS,
    ],
    [
      `funções acima de complexidade ${LIMITE_COMPLEXIDADE}`,
      complexasAntes,
      medido.funcoes_complexas,
      LIMITE_COMPLEXIDADE,
    ],
  ] as const) {
    if (agora > base) {
      problemas.push(
        `${rotulo}: eram ${base}, agora são ${agora} (limite de faixa: ${limite}).`,
      );
    }
  }

  const melhorou =
    problemas.length === 0 &&
    (medido.maior_arquivo.linhas < maiorArquivo ||
      medido.maior_funcao.complexidade < maiorFuncao ||
      medido.arquivos_grandes < grandesAntes ||
      medido.funcoes_complexas < complexasAntes ||
      // Escopo que cresceu também é regravação: sem registrar a subida, a
      // árvore poderia crescer e encolher de volta sem o portão ver nada.
      medido.arquivos > arquivosAntes ||
      medido.funcoes > funcoesAntes);

  return {
    problemas,
    melhorou: consolidarMelhora(problemas, melhorou, medido, anterior),
  };
}

function consolidarMelhora(
  problemas: readonly string[],
  melhorou: boolean,
  medido: Medicao,
  anterior: Record<string, unknown>,
): boolean {
  return (
    problemas.length === 0 && (melhorou || individuaisMudaram(medido, anterior))
  );
}

function referenciaDeArquivo(valor: unknown): number {
  const bloco = valor as { readonly linhas?: unknown } | null;
  return numero(bloco?.linhas, "maior_arquivo.linhas");
}

function referenciaDeFuncao(valor: unknown): number {
  const bloco = valor as { readonly complexidade?: unknown } | null;
  return numero(bloco?.complexidade, "maior_funcao.complexidade");
}

export function relatorio(medido: Medicao): string {
  return (
    `Tamanho e complexidade: ${medido.arquivos} arquivos (${medido.linhas} linhas), ` +
    `maior ${medido.maior_arquivo.caminho} com ${medido.maior_arquivo.linhas}; ` +
    `${medido.funcoes} funções, mais complexa ` +
    `${medido.maior_funcao.caminho}:${medido.maior_funcao.linha} ` +
    `\`${medido.maior_funcao.nome}\` com ${medido.maior_funcao.complexidade}; ` +
    `${medido.arquivos_grandes} arquivos > ${LIMITE_LINHAS} linhas, ` +
    `${medido.funcoes_complexas} funções > ${LIMITE_COMPLEXIDADE}.`
  );
}

function exigirBaselineSomenteLeitura(
  baseline: unknown,
  atualizar: boolean,
  somenteLeitura: boolean,
): void {
  if (somenteLeitura && atualizar) {
    throw new Error(
      "Não é permitido atualizar o baseline em modo somente leitura ou CI.",
    );
  }
  if (
    somenteLeitura &&
    (baseline === null ||
      typeof baseline !== "object" ||
      Array.isArray(baseline))
  ) {
    throw new Error(
      "Baseline ausente ou inválido em modo somente leitura ou CI. " +
        "Crie ou migre localmente com `npm run complexity:baseline`.",
    );
  }
}

export function executarPortaoDeTamanho({
  arquivos = descobrirFontes(),
  ler = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8"),
  baseline = secaoExigida(lerBaseline()),
  atualizar = false,
  somenteLeitura = baselineEhSomenteLeitura(),
  gravar = gravarSecao,
}: {
  readonly arquivos?: readonly string[];
  readonly ler?: (caminho: string) => string;
  readonly baseline?: unknown;
  readonly atualizar?: boolean;
  readonly somenteLeitura?: boolean;
  readonly gravar?: typeof gravarSecao;
} = {}): string {
  exigirBaselineSomenteLeitura(baseline, atualizar, somenteLeitura);
  if (arquivos.length === 0) {
    throw new Error(
      "Nenhum arquivo de código encontrado. O portão perdeu a visão da árvore " +
        "antes de aprovar qualquer coisa — confira ALVOS.",
    );
  }

  const medido = medir(arquivos, ler);
  const { problemas, melhorou } = avaliar(medido, atualizar ? null : baseline);
  if (problemas.length > 0) {
    throw new Error(
      `${relatorio(medido)}\n${problemas.map((item) => `  ${item}`).join("\n")}`,
    );
  }
  if ((melhorou || atualizar) && !somenteLeitura) {
    gravar(SECAO, { ...medido });
    return `${relatorio(medido)} Baseline regravado; commite tools/quality/tamanho-baseline.json.`;
  }
  return relatorio(medido);
}

/**
 * Flag desconhecida REPROVA em vez de ser ignorada: `--atualiza-baseline`
 * digitado errado rodaria o portão normal e deixaria quem pediu a regravação
 * achando que ela aconteceu.
 */
export function interpretarArgumentos(argumentos: readonly string[]): boolean {
  const desconhecido = argumentos.find(
    (argumento) => argumento !== "--atualizar-baseline",
  );
  if (desconhecido !== undefined) {
    throw new Error(
      `Opção desconhecida: ${desconhecido}. A única aceita é \`--atualizar-baseline\`.`,
    );
  }
  return argumentos.includes("--atualizar-baseline");
}

export function main(
  argumentos: readonly string[] = process.argv.slice(2),
): void {
  let atualizar: boolean;
  try {
    atualizar = interpretarArgumentos(argumentos);
  } catch (erro) {
    console.error(`✖ ${erro instanceof Error ? erro.message : String(erro)}`);
    // 2, e não 1: erro de uso não é reprovação de qualidade.
    process.exitCode = 2;
    return;
  }
  relatarPortao(() =>
    executarPortaoDeTamanho({
      atualizar,
      // Regravar de propósito não pode esbarrar na seção que falta: é
      // justamente o comando que a recria.
      baseline: atualizar ? null : secaoExigida(lerBaseline()),
    }),
  );
}

if (import.meta.main) main();
