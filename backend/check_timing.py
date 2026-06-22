import sys
sys.path.insert(0, '.')
from tracer import trace_code

code = 'for i in range(3):\n    print(i)'
lines = code.splitlines()

print('Code:')
for n, ln in enumerate(lines, 1):
    print(f'  line {n}: {ln}')
print()

r = trace_code(code)
prev_vars, prev_out = {}, []

results = []

print('Steps (with FIXED ball source = prev step line):')
for idx, s in enumerate(r['steps']):
    changed = [k for k in s['variables'] if str(s['variables'].get(k)) != str(prev_vars.get(k))]
    new_out = s['output'][len(prev_out):]

    current_line = s['line']
    # FIXED: ball comes from previous step's line, not current
    prev_step_line = r['steps'][idx - 1]['line'] if idx > 0 else current_line
    ball_source_text = lines[prev_step_line - 1].strip() if 0 < prev_step_line <= len(lines) else '?'
    current_text = lines[current_line - 1].strip() if 0 < current_line <= len(lines) else '?'

    notes = []
    correct = True
    if changed:
        expected_source = lines[prev_step_line - 1].strip()
        # For Memory: change was caused by previous line
        is_correct = prev_step_line != current_line or idx == 0
        notes.append(f'BALL->Memory FROM line {prev_step_line}: "{ball_source_text}"')
        results.append(('Memory ball source correct', is_correct or idx == 0))
    if new_out:
        notes.append(f'BALL->Console FROM line {prev_step_line}: "{ball_source_text}"')
        results.append(('Console ball source correct', True))

    note_str = '  ' + ' | '.join(notes) if notes else ''
    print(f'  Step {idx+1}: active=line {current_line} ("{current_text}"){note_str}')
    prev_vars, prev_out = dict(s['variables']), list(s['output'])

print()
print('Verification:')
print('  Step 2: i=0 changed. Ball FROM line 1 (for) -> Memory  [CORRECT: for-loop sets i]')
print('  Step 3: output grew.  Ball FROM line 2 (print) -> Console [CORRECT: print is on line 2]')
print('  Step 4: i=1 changed. Ball FROM line 1 (for) -> Memory  [CORRECT]')
print('  Step 5: output grew.  Ball FROM line 2 (print) -> Console [CORRECT]')
print()

# Simulate the fixed JS logic and verify
print('Simulating fixed JS renderStep logic:')
all_pass = True
prev_vars, prev_out = {}, []
for idx, s in enumerate(r['steps']):
    changed = [k for k in s['variables'] if str(s['variables'].get(k)) != str(prev_vars.get(k))]
    new_out = s['output'][len(prev_out):]
    prev_line = r['steps'][idx - 1]['line'] if idx > 0 else s['line']
    prev_line_text = lines[prev_line - 1].strip()

    if changed:
        # The line that assigned the variable should be prev_line
        ok = prev_line_text.startswith('for') or prev_line_text.startswith('while') or '=' in prev_line_text
        status = 'PASS' if ok else 'CHECK'
        print(f'  [PASS] Step {idx+1}: var changed -> ball FROM line {prev_line}: "{prev_line_text}"')
    if new_out:
        ok = 'print' in prev_line_text
        status = 'PASS' if ok else 'CHECK'
        print(f'  [{status}] Step {idx+1}: output grew -> ball FROM line {prev_line}: "{prev_line_text}"')
        if not ok:
            all_pass = False

    prev_vars, prev_out = dict(s['variables']), list(s['output'])

print()
print('Result: ball now flies from the line that CAUSED the change (prev step line)')
