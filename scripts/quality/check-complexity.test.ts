import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { descobrirFontes, avaliar, contarLinhas, funcoesDoArquivo, medir, interpretarArgumentos, baselineEhSomenteLeitura } from "./check-complexity.ts";

describe("limites comuns500/15 e legado individual", () => {
  it("descobre extensões de módulos, excluindo testes e declarações", () => {
    const arquivos = descobrirFontes("/repo", ["src"], () => [
      "f:produto.mjs", "f:produto.cts", "f:produto.test.mjs",
      "f:produto.spec.cts", "f:produto.d.mts", "f:produto.d.cts"
    ]);
    assert.deepEqual(arquivos, ["src/produto.cts", "src/produto.mjs"]);
  });
  it("conta linhas físicas e reconhece500/501", () => {
    assert.equal(contarLinhas("x\n".repeat(500)),500);
    const dentro=medir(["src/a.ts"],()=>"x\n".repeat(500));
    const fora=medir(["src/a.ts"],()=>"x\n".repeat(501));
    assert.equal(dentro.arquivos_grandes,0);
    assert.equal(fora.arquivos_grandes,1);
    assert.ok(avaliar(fora,dentro).problemas.length>0);
  });
  it("aceita complexidade15 e bloqueia16 como dívida nova", () => {
    const codigo = (ramos: number) => "function operar(x) {" + "if(x) executar();".repeat(ramos) + "}";
    const dentro = medir(["src/a.ts"], () => codigo(14));
    const fora = medir(["src/a.ts"], () => codigo(15));
    assert.equal(dentro.maior_funcao.complexidade, 15);
    assert.equal(dentro.funcoes_complexas, 0);
    assert.equal(fora.funcoes_complexas, 1);
    assert.ok(avaliar(fora, dentro).problemas.length > 0);
  });
  it("mede função filha separadamente e não permite piorar cap", () => {
    const texto="function pai(x) { function filha(x) { if(x) executar(); } return filha; }";
    const funcoes=funcoesDoArquivo("src/a.ts",texto);
    assert.deepEqual(funcoes.map(f=>f.complexidade),[1,2]);
    const anterior=medir(["src/a.ts"],()=>"function a(x){"+"if(x) executar();".repeat(15)+"}");
    const atual=medir(["src/a.ts"],()=>"function a(x){"+"if(x) executar();".repeat(16)+"}");
    assert.equal(anterior.funcoes_complexas,1);
    assert.ok(avaliar(atual,anterior).problemas.length>0);
  });
  it("não permite dívida nova nem encolher escopo silenciosamente", () => {
    const anterior=medir(["src/a.ts","src/b.ts"],()=>"function a(){}");
    const atual=medir(["src/a.ts"],()=>"function a(){}");
    assert.ok(avaliar(atual,anterior).problemas.length>0);
    assert.throws(()=>medir([],()=>""));
  });
  it("recusa flag desconhecida e reconheceCI somenteleitura",()=>{
    assert.throws(()=>interpretarArgumentos(["--ignorar"]));
    assert.equal(baselineEhSomenteLeitura({CI:"1"}),true);
  });
});
