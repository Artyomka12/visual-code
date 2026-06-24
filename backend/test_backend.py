from validator import validate
from tracer import trace_code

results = []

def check(name, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    results.append((name, status, detail))
    print(f'[{status}] {name}' + (f' | {detail}' if detail else ''))


# Test 1: for loop validation and tracing
code = 'for i in range(3):\n    print(i)'
valid, err = validate(code)
check('T1: for loop valid', valid)
r = trace_code(code)
check('T1: for loop steps > 0', len(r['steps']) > 0, f'steps={len(r["steps"])}')
check('T1: for loop no error', r['error'] is None)
last_out = r['steps'][-1]['output']
check('T1: for loop output correct', last_out == ['0', '1', '2'], f'output={last_out}')

# Test 2: while loop
code2 = 'x = 1\nwhile x < 4:\n    x = x + 1'
valid2, _ = validate(code2)
check('T2: while loop valid', valid2)
r2 = trace_code(code2)
final_x = r2['steps'][-1]['variables'].get('x')
check('T2: while loop final x=4', final_x == 4, f'x={final_x}')

# Test 3: import blocked
v3, e3 = validate('import os')
check('T3: import blocked', not v3, e3)

# Test 4: if/else
code4 = 'a = 5\nb = 3\nif a > b:\n    print(a)'
valid4, _ = validate(code4)
r4 = trace_code(code4)
check('T4: if statement valid', valid4)
check('T4: if statement output', r4['steps'][-1]['output'] == ['5'], f'output={r4["steps"][-1]["output"]}')

# Test 5: list operations
code5 = 'lst = [1, 2, 3]\nlst.append(4)\nprint(len(lst))'
valid5, _ = validate(code5)
r5 = trace_code(code5)
check('T5: list ops valid', valid5)
check('T5: list output = 4', r5['steps'][-1]['output'] == ['4'], f'output={r5["steps"][-1]["output"]}')

# Test 6: truncation at 600 steps
code6 = 'for i in range(2000):\n    x = i'
r6 = trace_code(code6)
line_steps6 = [s for s in r6['steps'] if s.get('event', 'line') == 'line']
check('T6: truncation activated', r6['truncated'], f'steps={len(r6["steps"])}')
check('T6: max 600 line-steps', len(line_steps6) <= 600, f'line_steps={len(line_steps6)}')

# Test 7: runtime error captured
code7 = 'x = 1 / 0'
valid7, _ = validate(code7)
r7 = trace_code(code7)
check('T7: division error valid syntax', valid7)
check('T7: division error captured', r7['error'] is not None, str(r7['error']))

# Test 8: variables in step correctly scoped
code8 = 'a = 10\nb = 20\nc = a + b'
r8 = trace_code(code8)
last_step = r8['steps'][-1]
check('T8: variables scope - only user vars', 'print' not in last_step['variables'])
check('T8: variables scope - a,b,c present', all(k in last_step['variables'] for k in ['a','b','c']), str(last_step['variables']))

print()
passed = sum(1 for _, s, _ in results if s == 'PASS')
total = len(results)
print(f'Result: {passed}/{total} tests passed')
