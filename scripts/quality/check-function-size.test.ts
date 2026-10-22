import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  avaliarFuncoes,
  criarBaseline,
  executarFuncoes,
  medirFuncoes,
  validarBaseline,
} from "./check-function-size.ts";

const codigo = (linhas: number): string =>
  `export function operar() {\n${"  executar();\n".repeat(linhas - 2)}}\n`;
const medir = (texto: string, caminho = "produto.ts") =>
  medirFuncoes([caminho], () => texto);

describe("tamanho efetivo por função", () => {
  it("conta assinatura e corpo, ignorando vazios e comentários", () => {
    const medido = medir(
      "function operar() {\n\n// explicação\n/* várias\n linhas */\n executar(); // ação\n}\n",
    );
    assert.equal(medido.funcoes[0]?.linhas, 3);
  });
  it("preserva strings multilinha e // dentro de string", () => {
    const medido = medir(
      "function operar() {\n return `https://exemplo\ntexto\n`;\n}",
    );
    assert.equal(medido.funcoes[0]?.linhas, 5);
  });
  it("ignora marcação JSX, mas mede expressões e callbacks de lógica", () => {
    const medido = medir(
      "function Tela() {\n const valor = obter();\n return <main>\n <section>\n {itens.map((item) => {\n executar(item);\n return item;\n })}\n </section>\n </main>;\n}",
      "tela.tsx",
    );
    assert.equal(medido.funcoes.length, 2);
    assert.equal(medido.funcoes[0]?.linhas, 9);
    assert.equal(medido.funcoes[1]?.linhas, 4);
  });
  it("mede lógica em spread JSX e callbacks de atributos", () => {
    const medido = medir(
      "function Tela() {\n return <Tela\n {...montarProps(\n obterDado(),\n outroDado()\n )}\n onClick={() => {\n executar();\n confirmar();\n }}\n />;\n}",
      "tela.tsx",
    );
    assert.equal(medido.funcoes.length, 2);
    assert.equal(medido.funcoes[0]?.linhas, 12);
    assert.equal(medido.funcoes[1]?.linhas, 4);
  });
  it("recusa sintaxe inválida, recorte vazio e fonte sem funções", () => {
    assert.throws(() => medir("function quebrada( {"), /Sintaxe/);
    assert.throws(() => medirFuncoes([], () => ""), /vazio/);
    assert.throws(() => medir("const dado = 1;"), /Nenhuma função/);
  });
  it("propaga erro de leitura em vez de aprovar arquivo omitido", () => {
    assert.throws(
      () =>
        medirFuncoes(["ausente.ts"], () => {
          throw new Error("leitura");
        }),
      /leitura/,
    );
  });
});

describe("ratchet de funções com limite150", () => {
  it("aceita até150 sem objetivo consultivo ou metadado de objetivo", () => {
    for (const linhas of [50, 120, 150]) {
      const medido = medir(codigo(linhas));
      const baseline = criarBaseline(medido);
      assert.deepEqual(baseline.limiares, { limite: 150 });
      assert.deepEqual(baseline.por_funcao, {});
      const resumo = executarFuncoes({
        medido,
        baseline,
        somenteLeitura: true,
        gravar: () => assert.fail(),
      });
      assert.doesNotMatch(resumo, /objetivo|consultivo|\b50\b/u);
      assert.match(resumo, /0 acima de 150 linhas efetivas/u);
    }
  });
  it("recusa metadado legado de objetivo consultivo", () => {
    const baseline = criarBaseline(medir(codigo(150)));
    assert.throws(
      () =>
        validarBaseline({
          ...baseline,
          limiares: { limite: 150, objetivo: 50 },
        }),
      /inválidos/u,
    );
  });
  it("recusa função nova acima de150 e crescimento da dívida existente", () => {
    const baseline = criarBaseline(medir(codigo(150)));
    assert.equal(avaliarFuncoes(medir(codigo(151)), baseline).length, 1);
    const legado = criarBaseline(medir(codigo(170)));
    assert.equal(avaliarFuncoes(medir(codigo(171)), legado).length, 1);
  });
  it("redução remove cap ao atingir150 e impede recuperá-lo", () => {
    let baseline = criarBaseline(medir(codigo(170)));
    executarFuncoes({
      medido: medir(codigo(150)),
      baseline,
      gravar: (novo) => {
        baseline = novo;
      },
    });
    assert.deepEqual(baseline.por_funcao, {});
    assert.equal(avaliarFuncoes(medir(codigo(151)), baseline).length, 1);
  });
  it("identidade preserva cap após deslocamento de linhas", () => {
    const original = medir(codigo(170));
    assert.deepEqual(
      avaliarFuncoes(
        medir(`\n// deslocamento\n${codigo(170)}`),
        criarBaseline(original),
      ),
      [],
    );
  });
  it("callback novo não herda cap de outra âncora lexical", () => {
    const original = medir(
      `const executar = () => {\n${"acao();\n".repeat(170)}};`,
    );
    const outra = medir(`const outra = () => {\n${"acao();\n".repeat(170)}};`);
    assert.equal(avaliarFuncoes(outra, criarBaseline(original)).length, 1);
  });
  it("CI não escreve nem permite atualização explícita", () => {
    const medido = medir(codigo(170));
    const baseline = criarBaseline(medido);
    assert.doesNotThrow(() =>
      executarFuncoes({
        medido: medir(codigo(160)),
        baseline,
        somenteLeitura: true,
        gravar: () => assert.fail(),
      }),
    );
    assert.throws(
      () =>
        executarFuncoes({
          medido,
          baseline,
          atualizar: true,
          somenteLeitura: true,
          gravar: () => assert.fail(),
        }),
      /CI/,
    );
  });
  it("recusa baseline incompleto, caps inválidos e redução de escopo", () => {
    const medido = medir(codigo(170));
    assert.throws(() => validarBaseline({}), /incompleto/);
    assert.throws(
      () =>
        validarBaseline({
          ...criarBaseline(medido),
          por_funcao: { invalido: 149 },
        }),
      /inválidos/,
    );
    assert.equal(
      avaliarFuncoes(medido, { ...criarBaseline(medido), arquivos: 2 }).length,
      1,
    );
  });
  it("recusa identidades ambíguas de callbacks longos", () => {
    const medido = medir(
      `repetir(() => {\n${"acao();\n".repeat(151)}});\nrepetir(() => {\n${"acao();\n".repeat(151)}});`,
    );
    assert.throws(() => criarBaseline(medido), /ambígua/);
  });
});
