import sys, threading, socket, json, time
sys.path.insert(0, '.')
from http.server import HTTPServer
from main import Handler

server = HTTPServer(('127.0.0.1', 0), Handler)  # port=0: OS assigns a free port
port = server.server_address[1]
t = threading.Thread(target=server.serve_forever, daemon=True)
t.start()
time.sleep(0.3)

def raw_req(method, path, body=None):
    s = socket.socket()
    s.settimeout(5)
    s.connect(('127.0.0.1', port))
    if body:
        b = json.dumps(body).encode()
        headers = f'{method} {path} HTTP/1.0\r\nHost:127.0.0.1\r\nContent-Type:application/json\r\nContent-Length:{len(b)}\r\n\r\n'
        s.sendall(headers.encode() + b)
    else:
        s.sendall(f'{method} {path} HTTP/1.0\r\nHost:127.0.0.1\r\n\r\n'.encode())
    data = b''
    while True:
        try:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        except Exception:
            break
    s.close()
    idx = data.find(b'\r\n\r\n')
    return data[idx + 4:] if idx >= 0 else data

results = []

def check(name, cond, detail=''):
    status = 'PASS' if cond else 'FAIL'
    results.append((name, status, detail))
    print(f'[{status}] {name}' + (f' | {detail}' if detail else ''))

# Test 1: health endpoint
r = raw_req('GET', '/health')
d = json.loads(r)
check('GET /health', d.get('status') == 'ok', str(d))

# Test 2: for loop trace
r2 = raw_req('POST', '/trace', {'code': 'for i in range(3):\n    print(i)'})
d2 = json.loads(r2)
steps_count = len(d2['steps'])
check('POST /trace: steps > 0', steps_count > 0, str(steps_count) + ' steps')
check('POST /trace: correct output', d2['steps'][-1]['output'] == ['0', '1', '2'], str(d2['steps'][-1]['output']))
check('POST /trace: no error', d2['error'] is None)

# Test 3: import blocked
r3 = raw_req('POST', '/trace', {'code': 'import os'})
d3 = json.loads(r3)
check('POST /trace import blocked', d3['error'] is not None and len(d3['steps']) == 0, str(d3['error']))

# Test 4: while loop
r4 = raw_req('POST', '/trace', {'code': 'x = 0\nwhile x < 3:\n    x = x + 1\nprint(x)'})
d4 = json.loads(r4)
final_x = d4['steps'][-1]['variables'].get('x')
check('POST /trace while loop x=3', final_x == 3, 'x=' + str(final_x))

# Test 5: static file
r5 = raw_req('GET', '/index.html')
check('GET /index.html returns HTML', b'<!DOCTYPE' in r5 or b'html' in r5.lower(), str(len(r5)) + ' bytes')

server.shutdown()
print()
passed = sum(1 for _, s, _ in results if s == 'PASS')
print(f'Server tests: {passed}/{len(results)} passed')
