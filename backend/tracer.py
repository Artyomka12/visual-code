import sys
import copy

MAX_STEPS = 300

SAFE_BUILTINS = {
    'print': None,  # replaced at runtime
    'range': range,
    'len': len,
    'int': int,
    'float': float,
    'str': str,
    'bool': bool,
    'abs': abs,
    'min': min,
    'max': max,
    'sum': sum,
    'round': round,
    'sorted': sorted,
    'reversed': reversed,
    'list': list,
    'tuple': tuple,
    'dict': dict,
    'set': set,
    'enumerate': enumerate,
    'zip': zip,
    'type': type,
    'True': True,
    'False': False,
    'None': None,
}


def _serialize(value, depth=0):
    if depth > 3:
        return '...'
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return value[:200]
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        items = [_serialize(v, depth + 1) for v in value[:30]]
        return items
    if isinstance(value, dict):
        return {str(k): _serialize(v, depth + 1) for k, v in list(value.items())[:15]}
    if isinstance(value, set):
        return sorted([_serialize(v, depth + 1) for v in list(value)[:15]], key=str)
    return str(value)[:100]


def trace_code(code: str) -> dict:
    steps = []
    output_lines = []
    error_info = None

    initial_namespace_keys = set(SAFE_BUILTINS.keys()) | {'__builtins__', '__name__', '__doc__', '__package__', '__loader__', '__spec__'}

    captured_output = []

    def custom_print(*args, sep=' ', end='\n', **kwargs):
        text = sep.join(str(a) for a in args)
        captured_output.append(text)

    namespace = dict(SAFE_BUILTINS)
    namespace['print'] = custom_print
    namespace['__builtins__'] = {}

    def make_tracer():
        step_count = [0]
        limit_hit = [False]

        def tracer(frame, event, arg):
            if frame.f_code.co_filename != 'user_code':
                return None

            if event != 'line':
                return tracer

            if step_count[0] >= MAX_STEPS:
                if not limit_hit[0]:
                    limit_hit[0] = True
                return tracer

            step_count[0] += 1

            local_vars = {}
            for k, v in frame.f_locals.items():
                if k in initial_namespace_keys or k.startswith('_'):
                    continue
                try:
                    local_vars[k] = _serialize(v)
                except Exception:
                    local_vars[k] = '<не отображается>'

            steps.append({
                'line': frame.f_lineno,
                'variables': copy.deepcopy(local_vars),
                'output': list(captured_output),
            })

            return tracer

        return tracer, limit_hit

    tracer_fn, limit_hit = make_tracer()

    try:
        compiled = compile(code, 'user_code', 'exec')
        sys.settrace(tracer_fn)
        exec(compiled, namespace)
    except Exception as e:
        error_info = {
            'type': type(e).__name__,
            'message': str(e),
            'line': getattr(e, 'lineno', None),
        }
    finally:
        sys.settrace(None)

    # Collect final variable state from namespace after execution
    final_vars = {}
    for k, v in namespace.items():
        if k in initial_namespace_keys or k.startswith('_'):
            continue
        try:
            final_vars[k] = _serialize(v)
        except Exception:
            final_vars[k] = '<не отображается>'

    final_output = list(captured_output)

    # Add synthetic final step if output or variables differ from last recorded step
    if error_info is None and not limit_hit[0]:
        last = steps[-1] if steps else None
        if last is None or last['output'] != final_output or last['variables'] != final_vars:
            last_line = last['line'] if last else 1
            steps.append({
                'line': last_line,
                'variables': copy.deepcopy(final_vars),
                'output': final_output,
                'final': True,
            })

    result = {
        'steps': steps,
        'error': error_info,
        'truncated': limit_hit[0],
        'total_lines': len(code.splitlines()),
    }
    return result
