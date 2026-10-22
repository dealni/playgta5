"""Portão AST portátil: arquivos 500, ciclomática 15, função 150 linhas."""
import argparse
import ast
import fnmatch
import io
import json
import os
from pathlib import Path
import tokenize

FILE_LIMIT = 500
COMPLEXITY_LIMIT = 15
FUNCTION_LIMIT = 150


def effective_lines(source):
    """Linhas com tokens; comentários e linhas vazias não contam."""
    lines = set()
    physical = source.splitlines()
    ignored = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT,
               tokenize.DEDENT, tokenize.ENDMARKER, tokenize.ENCODING}
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type not in ignored:
            lines.update(line for line in range(token.start[0], token.end[0] + 1)
                         if line <= len(physical) and physical[line - 1].strip())
    return lines


def complexity(function):
    """Cada função é independente: não soma decisões de funções/classes filhas."""
    total = 1

    def visit(node):
        nonlocal total
        if node is not function and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                                                      ast.Lambda, ast.ClassDef)):
            return
        if isinstance(node, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While,
                             ast.ExceptHandler)):
            total += 1
        elif isinstance(node, ast.BoolOp):
            total += len(node.values) - 1
        elif isinstance(node, ast.comprehension):
            total += 1 + len(node.ifs)
        elif isinstance(node, ast.match_case):
            total += not (isinstance(node.pattern, ast.MatchAs) and node.pattern.name is None
                          and node.pattern.pattern is None)
            total += node.guard is not None
        for child in ast.iter_child_nodes(node):
            visit(child)
    visit(function)
    return total


def callable_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return callable_name(node.value) + '.' + node.attr
    if isinstance(node, (ast.Call, ast.Subscript)):
        return callable_name(node.func if isinstance(node, ast.Call) else node.value) + '()'
    return type(node).__name__


def lambda_name(parent, node, parents):
    if isinstance(parent, (ast.Assign, ast.AnnAssign)):
        target = parent.targets[0] if isinstance(parent, ast.Assign) else parent.target
        if isinstance(target, ast.Name):
            return '<lambda:' + target.id + '>'
    if isinstance(parent, ast.Call):
        for index, argument in enumerate(parent.args):
            if argument is node:
                return '<lambda:' + callable_name(parent.func) + ':arg' + str(index) + '>'
    if isinstance(parent, ast.keyword):
        call = parents.get(parent)
        if isinstance(call, ast.Call):
            return '<lambda:' + callable_name(call.func) + ':keyword:' + str(parent.arg) + '>'
    return '<lambda>'


def measure_file(path, source):
    tree = ast.parse(source, filename=path)
    actual_lines = effective_lines(source)
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    functions = []

    def visit(node, scopes, parent=None):
        name = lambda_name(parent, node, parents) if isinstance(node, ast.Lambda) else getattr(node, 'name', None)
        scope = scopes + ([name] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                                                    ast.ClassDef, ast.Lambda)) else [])
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            functions.append({'identity': '/'.join(scope), 'line': node.lineno,
                              'size': sum(node.lineno <= line <= node.end_lineno
                                          for line in actual_lines),
                              'complexity': complexity(node)})
        for child in ast.iter_child_nodes(node):
            visit(child, scope, node)
    visit(tree, [])
    return {'lines': len(source.splitlines()), 'functions': functions}


def discover(root, config):
    paths = set()
    for pattern in config['sources']:
        for path in root.glob(pattern):
            relative = path.relative_to(root).as_posix()
            if path.is_file() and not any(fnmatch.fnmatch(relative, skip)
                                          for skip in config.get('exclude', [])):
                paths.add(relative)
    if not paths:
        raise ValueError('Escopo vazio: nenhum arquivo Python de produto encontrado.')
    return sorted(paths)


def inventory(measurements):
    debt = {}
    identities = {}
    for path, item in measurements.items():
        if item['lines'] > FILE_LIMIT:
            debt[f'file:{path}'] = item['lines']
        for function in item['functions']:
            identity = f"{path}:{function['identity']}"
            identities.setdefault(identity, []).append(function)
            if function['size'] > FUNCTION_LIMIT:
                debt[f'function:{identity}'] = function['size']
            if function['complexity'] > COMPLEXITY_LIMIT:
                debt[f'complexity:{identity}'] = function['complexity']
    for identity, functions in identities.items():
        if len(functions) > 1 and any(function['size'] > FUNCTION_LIMIT or function['complexity'] > COMPLEXITY_LIMIT for function in functions):
            raise ValueError(f'Identidade de função ambígua: {identity}')
    return debt


def validate(current, previous, allow_scope_change=False):
    if (not isinstance(previous, dict) or previous.get('limits') != limits()
            or not isinstance(previous.get('files'), list)
            or not isinstance(previous.get('functions'), list)
            or not isinstance(previous.get('debt'), dict)
            or any(not isinstance(key, str) or not isinstance(value, int) or isinstance(value, bool)
                   or value < 1 for key, value in previous.get('debt', {}).items())):
        raise ValueError('Baseline ausente/incompatível; revisão explícita dos limites necessária.')
    if not allow_scope_change and (set(previous['files']) - set(current['files'])
                                  or set(previous['functions']) - set(current['functions'])):
        raise ValueError('Escopo encolheu: revise exclusões/remoções com --write-baseline.')
    for key, value in current['debt'].items():
        if key not in previous['debt'] or value > previous['debt'][key]:
            raise ValueError(f'Nova dívida ou piora: {key} = {value}')


def limits():
    return {'file': FILE_LIMIT, 'complexity': COMPLEXITY_LIMIT, 'function': FUNCTION_LIMIT}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('tools/quality/limits.json'))
    parser.add_argument('--write-baseline', action='store_true')
    args = parser.parse_args(argv)
    if args.write_baseline and os.environ.get('CI'):
        parser.error('CI é somente leitura; não pode regravar baseline.')
    config_path = args.config.resolve()
    root = config_path.parent.parent.parent
    config = json.loads(config_path.read_text())
    paths = discover(root, config)
    measurements = {path: measure_file(path, (root / path).read_text()) for path in paths}
    debt = inventory(measurements)
    current = {'limits': limits(), 'files': paths,
               'functions': sorted(f"{path}:{function['identity']}" for path, item in measurements.items() for function in item['functions']),
               'debt': debt}
    baseline = root / config['baseline']
    if baseline.exists():
        validate(current, json.loads(baseline.read_text()), allow_scope_change=args.write_baseline)
    elif not args.write_baseline:
        raise ValueError('Baseline ausente; inicialize explicitamente com --write-baseline.')
    if args.write_baseline:
        baseline.write_text(json.dumps(current, ensure_ascii=False, indent=2) + '\n')
    print(f'OK: {len(paths)} arquivos; {len(debt)} exceções.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, SyntaxError, tokenize.TokenError, OSError) as error:
        print(f'ERRO: {error}')
        raise SystemExit(1)
