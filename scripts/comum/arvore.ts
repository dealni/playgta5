/** Leitura de diretório injetável para testar o escopo dos portões AST. */

import { readdirSync } from "node:fs";

/** Uma entrada de diretório, marcada com o que ela é. */
export type Entrada = string;

export type Listar = (caminho: string) => readonly Entrada[];

export const listarEntradas: Listar = (caminho) =>
  readdirSync(caminho, { withFileTypes: true }).map(
    (entrada) => `${entrada.isDirectory() ? "d" : "f"}:${entrada.name}`,
  );

export const ehPasta = (entrada: Entrada): boolean => entrada.startsWith("d:");

export const nomeDaEntrada = (entrada: Entrada): string => entrada.slice(2);
