/**
 * Tamanho de funções de produto: acima de 150 linhas efetivas exige cap
 * individual que só diminui. Usa o mesmo recorte e a
 * mesma identidade lexical do ratchet de complexidade. Comentários, vazios e
 * marcação JSX não contam; expressões JSX e lógica continuam contando.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { descobrirFontes, identidadeDe } from "./check-complexity.ts";
import { relatarPortao } from "../comum/portao.ts";

export const LIMITE_LINHAS_FUNCAO = 150;
const RAIZ = fileURLToPath(new URL("../..", import.meta.url));
const BASELINE = join(RAIZ, "tools/quality/tamanho-funcoes-baseline.json");

export type FuncaoMedida = {
  readonly identidade: string;
  readonly caminho: string;
  readonly linha: number;
  readonly linhas: number;
};
export type MedicaoFuncoes = {
  readonly arquivos: number;
  readonly funcoes: readonly FuncaoMedida[];
};
export type BaselineFuncoes = {
  readonly limiares: { readonly limite: number };
  readonly arquivos: number;
  readonly funcoes: number;
  readonly por_funcao: Readonly<Record<string, number>>;
};

/** Conta as linhas com tokens, preservando strings multilinha como código. */
export function linhasEfetivas(no: ts.Node, fonte: ts.SourceFile): number {
  const linhas = new Set<number>();
  const expressaoJsx = (atual: ts.Node): void => {
    if (ts.isJsxExpression(atual) || ts.isJsxSpreadAttribute(atual)) {
      if (atual.expression !== undefined) visitar(atual.expression);
    } else ts.forEachChild(atual, expressaoJsx);
  };
  const visitar = (atual: ts.Node): void => {
    if (
      ts.isJsxElement(atual) ||
      ts.isJsxSelfClosingElement(atual) ||
      ts.isJsxFragment(atual)
    ) {
      expressaoJsx(atual);
      return;
    }
    const filhos = atual.getChildren(fonte);
    if (filhos.length > 0) {
      filhos.forEach(visitar);
      return;
    }
    const inicio = atual.getStart(fonte);
    const texto = fonte.text.slice(inicio, atual.end);
    const primeira = fonte.getLineAndCharacterOfPosition(inicio).line;
    texto.split(/\r?\n/u).forEach((parte, indice) => {
      if (parte.trim() !== "") linhas.add(primeira + indice);
    });
  };
  visitar(no);
  return linhas.size;
}

function temCorpo(no: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(no) ||
      ts.isFunctionExpression(no) ||
      ts.isArrowFunction(no) ||
      ts.isMethodDeclaration(no) ||
      ts.isConstructorDeclaration(no) ||
      ts.isGetAccessor(no) ||
      ts.isSetAccessor(no)) &&
    no.body !== undefined
  );
}

export function medirFuncoes(
  arquivos: readonly string[],
  ler: (caminho: string) => string,
): MedicaoFuncoes {
  if (arquivos.length === 0) throw new Error("Recorte de funções vazio.");
  const funcoes: FuncaoMedida[] = [];
  for (const caminho of arquivos) {
    const fonte = ts.createSourceFile(
      caminho,
      ler(caminho),
      ts.ScriptTarget.Latest,
      true,
      /\.[jt]sx$/u.test(caminho) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    // createSourceFile preserva os diagnósticos sintáticos no resultado; a API
    // pública de SourceFile não declara esse campo de leitura do parser.
    const diagnosticos = (
      fonte as ts.SourceFile & {
        readonly parseDiagnostics: readonly ts.Diagnostic[];
      }
    ).parseDiagnostics;
    if (diagnosticos.length > 0)
      throw new Error(`Sintaxe inválida: ${caminho}`);
    const visitar = (no: ts.Node): void => {
      if (temCorpo(no)) {
        funcoes.push({
          identidade: JSON.stringify([caminho, identidadeDe(no)]),
          caminho,
          linha:
            fonte.getLineAndCharacterOfPosition(no.getStart(fonte)).line + 1,
          linhas: linhasEfetivas(no, fonte),
        });
      }
      ts.forEachChild(no, visitar);
    };
    ts.forEachChild(fonte, visitar);
  }
  if (funcoes.length === 0) throw new Error("Nenhuma função no recorte.");
  return { arquivos: arquivos.length, funcoes };
}

export function criarBaseline(medido: MedicaoFuncoes): BaselineFuncoes {
  const porFuncao: Record<string, number> = {};
  const identidades = new Map<string, number>();
  for (const funcao of medido.funcoes) {
    identidades.set(
      funcao.identidade,
      (identidades.get(funcao.identidade) ?? 0) + 1,
    );
    if (funcao.linhas > LIMITE_LINHAS_FUNCAO) {
      porFuncao[funcao.identidade] = funcao.linhas;
    }
  }
  for (const identidade of Object.keys(porFuncao)) {
    if (identidades.get(identidade) !== 1) {
      throw new Error(`Identidade ambígua de função longa: ${identidade}`);
    }
  }
  return {
    limiares: {
      limite: LIMITE_LINHAS_FUNCAO,
    },
    arquivos: medido.arquivos,
    funcoes: medido.funcoes.length,
    por_funcao: porFuncao,
  };
}

function capsValidos(valor: unknown): boolean {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor))
    return false;
  return Object.values(valor).every(
    (cap: unknown) =>
      typeof cap === "number" &&
      Number.isInteger(cap) &&
      cap > LIMITE_LINHAS_FUNCAO,
  );
}

/** Baseline não pode ser substituído por objeto incompleto ou caps inválidos. */
export function validarBaseline(valor: unknown): BaselineFuncoes {
  if (valor === null || typeof valor !== "object") {
    throw new Error("Baseline de funções ausente ou inválido.");
  }
  const baseline = valor as Partial<BaselineFuncoes>;
  const escopoValido = [baseline.arquivos, baseline.funcoes].every(
    (quantidade) =>
      typeof quantidade === "number" &&
      Number.isInteger(quantidade) &&
      quantidade > 0,
  );
  if (
    baseline.limiares?.limite !== LIMITE_LINHAS_FUNCAO ||
    Object.keys(baseline.limiares).length !== 1 ||
    !escopoValido ||
    !capsValidos(baseline.por_funcao)
  ) {
    throw new Error(
      "Baseline de funções incompleto ou com limiares/caps inválidos.",
    );
  }
  return baseline as BaselineFuncoes;
}

export function avaliarFuncoes(
  medido: MedicaoFuncoes,
  valor: unknown,
): readonly string[] {
  const baseline = validarBaseline(valor);
  criarBaseline(medido); // Recusa identidades ambíguas antes de comparar caps.
  const problemas: string[] = [];
  if (
    medido.arquivos < baseline.arquivos ||
    medido.funcoes.length < baseline.funcoes
  ) {
    problemas.push(
      "Escopo de funções encolheu; revise o recorte e o baseline explicitamente.",
    );
  }
  for (const funcao of medido.funcoes) {
    const limite =
      baseline.por_funcao[funcao.identidade] ?? LIMITE_LINHAS_FUNCAO;
    if (funcao.linhas > limite) {
      problemas.push(
        `${funcao.caminho}:${funcao.linha}: ${funcao.linhas} linhas efetivas, cap ${limite}.`,
      );
    }
  }
  return problemas;
}

export function executarFuncoes({
  medido,
  baseline,
  atualizar = false,
  somenteLeitura = false,
  gravar,
}: {
  readonly medido: MedicaoFuncoes;
  readonly baseline: unknown;
  readonly atualizar?: boolean;
  readonly somenteLeitura?: boolean;
  readonly gravar: (valor: BaselineFuncoes) => void;
}): string {
  if (atualizar && somenteLeitura)
    throw new Error("CI não pode regravar baseline.");
  const atual = criarBaseline(medido);
  const problemas = atualizar ? [] : avaliarFuncoes(medido, baseline);
  if (problemas.length > 0) throw new Error(problemas.join("\n"));
  if (!somenteLeitura) gravar(atual);
  return `${medido.funcoes.length} funções em ${medido.arquivos} arquivos: ${Object.keys(atual.por_funcao).length} acima de ${LIMITE_LINHAS_FUNCAO} linhas efetivas (dívida individual).`;
}

export function main(
  argumentos: readonly string[] = process.argv.slice(2),
): void {
  relatarPortao(() => {
    if (argumentos.some((arg) => arg !== "--atualizar-baseline")) {
      throw new Error("Opção desconhecida no gate de funções.");
    }
    const atualizar = argumentos.includes("--atualizar-baseline");
    return executarFuncoes({
      medido: medirFuncoes(descobrirFontes(), (caminho) =>
        readFileSync(join(RAIZ, caminho), "utf8"),
      ),
      baseline:
        atualizar || !existsSync(BASELINE)
          ? null
          : JSON.parse(readFileSync(BASELINE, "utf8")),
      atualizar,
      somenteLeitura: Boolean(process.env.CI),
      gravar: (valor) =>
        writeFileSync(BASELINE, `${JSON.stringify(valor, null, 2)}\n`),
    });
  });
}

if (import.meta.main) main();
