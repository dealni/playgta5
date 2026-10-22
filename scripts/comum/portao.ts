/**
 * O fim de linha comum dos portões do item 21: imprimir o resumo quando passa,
 * a mensagem quando reprova, e sair com o código certo.
 *
 * `process.exitCode`, e não `process.exit()`: o segundo corta a saída ainda no
 * buffer, e a explicação da reprovação é justamente o que se perde.
 */

export function relatarPortao(executar: () => string): void {
  try {
    console.log(`✔ ${executar()}`);
  } catch (erro) {
    console.error(`✖ ${erro instanceof Error ? erro.message : String(erro)}`);
    process.exitCode = 1;
  }
}
