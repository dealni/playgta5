import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('quality_limits', Path(__file__).resolve().parents[1] / 'scripts/quality/limits.py')
limits = importlib.util.module_from_spec(spec)
spec.loader.exec_module(limits)


class LimitsTest(unittest.TestCase):
    def test_comments_blank_lines_and_multiline_string(self):
        source = 'def demo():\n    # comentário\n\n    text = """a\n\nb"""\n    return text\n'
        result = limits.measure_file('demo.py', source)
        self.assertEqual(result['lines'], 7)
        self.assertEqual(result['functions'][0]['size'], 4)

    def test_nested_functions_have_independent_complexity(self):
        source = 'def outer():\n    def inner(a):\n        return 1 if a else 0\n    return inner\n'
        functions = limits.measure_file('demo.py', source)['functions']
        self.assertEqual([(f['identity'], f['complexity']) for f in functions], [('outer', 1), ('outer/inner', 2)])

    def test_boolean_comprehension_and_exception_paths(self):
        source = 'def demo(a, b):\n    try:\n        return [x for x in a if x and b]\n    except ValueError:\n        return []\n'
        self.assertEqual(limits.measure_file('demo.py', source)['functions'][0]['complexity'], 5)

    def test_complexity_boundary_15_and_16(self):
        for branches in (14, 15):
            source = "def demo(value):\n" + "    if value: print(value)\n" * branches
            item = limits.measure_file("a.py", source)
            debt = limits.inventory({"a.py": item})
            self.assertEqual(item["functions"][0]["complexity"], branches + 1)
            self.assertEqual("complexity:a.py:demo" in debt, branches == 15)

    def test_no_advisory_below_function_limit(self):
        for count in (51, 150):
            source = 'def demo():\n' + '    pass\n' * (count - 1)
            debt = limits.inventory({'demo.py': limits.measure_file('demo.py', source)})
            self.assertEqual(debt, {})
        self.assertNotIn('function_target', limits.limits())
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CI': ''}):
            root = Path(directory)
            config = root / 'tools/quality/limits.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'sources': ['*.py'], 'baseline': 'baseline.json'}))
            (root / 'demo.py').write_text('def demo():\n' + '    pass\n' * 50)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                limits.main(['--config', str(config), '--write-baseline'])
            self.assertNotRegex(output.getvalue(), r'consultiv|objetivo|50 linhas')

    def test_function_boundary_150_151_and_ratchet(self):
        make = lambda count: 'def demo():\n' + '    pass\n' * (count - 1)
        for count in (150, 151):
            debt = limits.inventory({'demo.py': limits.measure_file('demo.py', make(count))})
            self.assertEqual('function:demo.py:demo' in debt, count == 151)
        previous = {'limits': limits.limits(), 'files': ['demo.py'],
                    'functions': ['demo.py:demo'], 'debt': {'function:demo.py:demo': 170}}
        current = {'files': ['demo.py'], 'functions': ['demo.py:demo'], 'debt': {}}
        limits.validate(current, previous)
        tightened = dict(current, limits=limits.limits())
        with self.assertRaises(ValueError):
            limits.validate(dict(current, debt={'function:demo.py:demo': 151}), tightened)

    def test_ratchet_refuses_new_debt_growth_and_scope_loss(self):
        previous = {'limits': limits.limits(), 'files': ['a.py'], 'functions': [], 'debt': {'file:a.py': 600}}
        limits.validate({'files': ['a.py'], 'functions': [], 'debt': {'file:a.py': 550}}, previous)
        for current in ({'files': ['a.py'], 'functions': [], 'debt': {'file:a.py': 601}}, {'files': ['a.py'], 'functions': [], 'debt': {'complexity:a.py:f': 16}}, {'files': [], 'functions': [], 'debt': {}}):
            with self.assertRaises(ValueError):
                limits.validate(current, previous)

    def test_lambda_decisions_are_measured_separately(self):
        source = 'f = lambda x: 1 if x else 0\ndef parent():\n    g = lambda x: 1 if x else 0\n    return g\n'
        functions = limits.measure_file('demo.py', source)['functions']
        self.assertEqual([(f['identity'], f['complexity']) for f in functions], [('<lambda:f>', 2), ('parent', 1), ('parent/<lambda:g>', 2)])

    def test_lambda_callback_identity_tracks_call_and_keyword(self):
        a = limits.measure_file('a.py', 'a(lambda x: x)\nsorted([], key=lambda x: x)\n')['functions']
        b = limits.measure_file('a.py', 'b(lambda x: x)\n')['functions']
        self.assertEqual(a[0]['identity'], '<lambda:a:arg0>')
        self.assertEqual(a[1]['identity'], '<lambda:sorted:keyword:key>')
        self.assertNotEqual(a[0]['identity'], b[0]['identity'])

    def test_ambiguous_identity_is_rejected_even_if_first_is_long(self):
        source = 'def f():\n' + '    pass\n' * 151 + 'def f():\n    pass\n'
        with self.assertRaises(ValueError):
            limits.inventory({'a.py': limits.measure_file('a.py', source)})

    def test_invalid_baseline_and_function_scope_removal(self):
        current = {'files': ['a.py'], 'functions': [], 'debt': {}}
        for baseline in (None, {}, {'limits': limits.limits(), 'files': [], 'functions': [], 'debt': {'x': True}}):
            with self.assertRaises(ValueError):
                limits.validate(current, baseline)
        previous = dict(current, limits=limits.limits(), functions=['a.py:f'])
        with self.assertRaises(ValueError):
            limits.validate(current, previous)
        limits.validate(current, previous, allow_scope_change=True)

    def test_physical_file_boundary_and_readonly_roundtrip_ratchet(self):
        for count in (500, 501):
            item = limits.measure_file('a.py', '# comentario\n' * count)
            debt = limits.inventory({'a.py': item})
            self.assertEqual('file:a.py' in debt, count > 500)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CI': ''}):
            root = Path(directory)
            config = root / 'tools/quality/limits.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'sources': ['*.py'], 'baseline': 'baseline.json'}))
            source = root / 'a.py'
            source.write_text('# c\n' * 520)
            with contextlib.redirect_stdout(io.StringIO()):
                limits.main(['--config', str(config), '--write-baseline'])
                before = (root / 'baseline.json').read_bytes()
                with patch.dict(os.environ, {'CI': '1'}):
                    limits.main(['--config', str(config)])
                self.assertEqual((root / 'baseline.json').read_bytes(), before)
                source.write_text('# c\n' * 500)
                limits.main(['--config', str(config), '--write-baseline'])
                self.assertEqual(json.loads((root / 'baseline.json').read_text())['debt'], {})
                source.write_text('# c\n' * 501)
                with self.assertRaises(ValueError):
                    limits.main(['--config', str(config), '--write-baseline'])

    def test_empty_scope_missing_baseline_and_ci_writes_fail(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CI': ''}):
            root = Path(directory)
            with self.assertRaises(ValueError):
                limits.discover(root, {'sources': ['*.py']})
            config = root / 'tools/quality/limits.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'sources': ['*.py'], 'baseline': 'baseline.json'}))
            (root / 'a.py').write_text('a = 1\n')
            with self.assertRaises(ValueError):
                limits.main(['--config', str(config)])
            with patch.dict(os.environ, {'CI': '1'}), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                limits.main(['--config', str(config), '--write-baseline'])


if __name__ == '__main__':
    unittest.main()
