# Visual Code

Интерактивный визуализатор выполнения Python-кода для подготовки к ЕГЭ по информатике в рамках проекта **ЕГЭволюция**.

Проект содержит два режима визуализации:

1. **Classic View** — пошаговая анимация с scope-блоками и шариками данных.
2. **Flow Graph View** (Experimental) — граф операций, по которому движутся токены данных.

---

## Содержание

1. [Структура проекта](#структура-проекта)
2. [Запуск](#запуск)
3. [Архитектура](#архитектура)
4. [Classic View](#classic-view)
5. [Flow Graph View](#flow-graph-view)
   - [Концепция](#концепция)
   - [Типы узлов](#поддерживаемые-типы-узлов)
   - [DataToken](#datatoken)
   - [Поддерживаемые сценарии](#поддерживаемые-сценарии)
   - [Статус реализации](#flow-graph-status)
6. [Бэкенд](#бэкенд)
7. [Фронтенд](#фронтенд)
8. [Система анимации](#система-анимации)
9. [Дерево областей видимости](#дерево-областей-видимости)
10. [Доступный синтаксис](#доступный-синтаксис)
11. [API](#api)
12. [Технические решения](#технические-решения)
13. [Release Notes](#release-notes)

---

## Структура проекта

```
visual code/
├── start.bat               # Запуск одним двойным кликом
├── DOCS.md                 # Эта документация
├── backend/
│   ├── main.py             # HTTP-сервер (встроенные модули Python, без pip)
│   ├── validator.py        # AST-валидатор кода (whitelist)
│   ├── tracer.py           # Трассировщик выполнения (sys.settrace)
│   ├── requirements.txt    # Не используется (зависимостей нет)
│   ├── test_backend.py     # Тесты бэкенда (17 тестов)
│   └── test_server.py      # Интеграционные тесты сервера
└── frontend/
    ├── index.html          # Единственная HTML-страница (три view)
    ├── style.css           # Светлая и тёмная тема (CSS-переменные + .dark)
    └── js/
        ├── api.js          # fetch-обёртка для /trace
        ├── editor.js       # CodeMirror, подсветка, управление view, тема, примеры
        ├── animator.js     # Classic View: шарики, scope-блоки, дерево
        └── flow-graph.js   # Flow Graph View: граф, токены, анимация
```

---

## Запуск

### Быстрый старт

Двойной клик по **`start.bat`** — откроет сервер на `http://localhost:5000`.

### Вручную

```bash
cd backend
python main.py
```

Затем открыть в браузере: `http://localhost:5000`

**Требования:** Python 3.10+. Сторонних пакетов не нужно — всё на встроенных модулях.

### Остановка

`Ctrl+C` в терминале.

---

## Архитектура

```
Python Code
     ↓
  Tracer  (backend/tracer.py — sys.settrace)
     ↓
Execution Steps  (steps[]: line / call / return)
     ↓
Visualization Mode
  ├── Classic View    (animator.js)
  └── Flow Graph View (flow-graph.js)
```

```
Браузер                          Бэкенд (Python)
─────────────────────────────    ──────────────────────────
┌─────────────┐   POST /trace    ┌──────────────┐
│  editor.js  │ ─────────────── ▶│  validator   │ ← AST-проверка
│             │                  └──────┬───────┘
│  Пользо-    │   { steps[] }          │ ok
│  ватель     │ ◀─────────────── ┌──────▼───────┐
│  вводит код │                  │   tracer     │ ← sys.settrace
└──────┬──────┘                  └──────────────┘
       │ steps
       ▼
┌──────────────────────────────┐
│   Режим визуализации         │
│  ┌────────────┐ ┌──────────┐ │
│  │animator.js │ │flow-graph│ │
│  │ (Classic)  │ │  .js     │ │
│  └────────────┘ └──────────┘ │
└──────────────────────────────┘
```

**Принцип работы:**

1. Пользователь пишет код в редакторе CodeMirror (или выбирает пример из выпадающего списка) и нажимает «Запустить»
2. `api.js` отправляет код на `POST /trace`
3. Бэкенд валидирует код через AST-whitelist
4. `tracer.py` выполняет код с `sys.settrace` и собирает события трёх типов: `call` (вызов функции), `return` (возврат), `line` (шаг строки)
5. Массив шагов (`steps[]`) возвращается в браузер
6. В зависимости от выбранного режима воспроизводит либо `animator.js`, либо `flow-graph.js`

---

## Classic View

Классический пошаговый режим. Активируется кнопкой «Classic» в переключателе режимов.

**Что отображается:**

- **Панель кода** — подсветка синтаксиса, активная строка выделена жёлтым фоном.
- **Scope-блоки** — каждый вызов функции получает отдельный блок, переменные обновляются внутри него. Блоки выстраиваются в дерево вызовов.
- **Шарики (DataBall)** — при изменении переменной из текущей строки вылетает цветной шарик и приземляется в нужную ячейку scope-блока.
- **Console** — вывод `print()`, строки появляются по мере выполнения.
- **Управление** — кнопки «⏮ ◀ ▶ ▶▶ ⏭», скорость (Медленно / Нормально / Быстро / Очень быстро), клавиши ← →, Пробел.

**Состояния scope-блока:**

| Класс | Смысл |
|-------|-------|
| `.active` | Выполнение сейчас в этой функции |
| `.waiting` | Вызов сделан, ждёт возврата дочерней функции |
| `.done` | Функция завершена, показывает `ret: значение` |

---

## Flow Graph View

### Концепция

Экспериментальный режим. Активируется кнопкой «Flow Graph» в переключателе режимов.

Программа представляется как **граф операций**:

```
ASSIGN(x=0) → LOOP(i:0→3) → COMPUTE(x=x+1) → PRINT(x) → CONSOLE
```

- **Узлы** — описывают действие (присваивание, вычисление, вывод).
- **Токены** — капсулы с данными (`[ x = 5 ]`), перемещающиеся между узлами.
- **Данные текут** по стрелкам от узла к узлу, трансформируясь на каждом шаге.

Граф строится из массива `steps[]` без изменений в бэкенде.

**Конвейер построения графа (flow-graph.js):**

```
steps[] + sourceCode
      ↓
  parseOps()         — определяет тип каждой операции
      ↓
  expandLoopBodyOps() — разворачивает bodyOps в плоский список
      ↓
  buildNodes()       — позиционирует узлы на canvas
      ↓
  buildEdges()       — строит линейную цепочку стрелок
      ↓
  buildTokens()      — создаёт токены с маршрутами
      ↓
  renderFlowGraph()  — рисует DOM + SVG
      ↓
  startFlowAnimation() — запускает последовательную анимацию
```

---

### Поддерживаемые типы узлов

Узлы регистрируются через два объекта:

- `FG_NODE_TYPES` — метки и функции генерации label.
- `FG_COLORS` — цветовая схема (border, glow, pulse).

Чтобы добавить новый тип узла — достаточно добавить запись в оба объекта.

---

#### AssignmentNode

**Назначение:** простое присваивание значения переменной.

**Пример кода:**
```python
x = 5
```

**В графе:**
```
┌─────────────────┐
│  ASSIGN         │
│  x = 5          │
└─────────────────┘
```

**Цвет:** синий (`#2D5CB8`).

Генерирует DataToken: `[ x = 5 ]`.

---

#### ComputeNode

**Назначение:** бинарная арифметическая операция, где хотя бы один операнд — переменная.

**Пример кода:**
```python
y = x + 2
x = x + 1
```

**В графе:**
```
┌─────────────────┐
│  COMPUTE        │
│  y = x + 2      │
└─────────────────┘
```

**Цвет:** янтарный (`#92400E`).

Токен трансформируется при прохождении через узел:
- **self-update** (`x = x + 1`): `[ x=5 ]` → squish → `[ x=6 ]` + amber glow.
- **rename** (`y = x + 2`): `[ x=5 ]` исчезает, появляется `[ y=7 ]`.

---

#### PrintNode

**Назначение:** вызов `print()` — транзитный узел перед ConsoleNode.

**Пример кода:**
```python
print(x)
```

**В графе:**
```
┌─────────────────┐
│  PRINT          │
│  print(x)       │
└─────────────────┘
```

**Цвет:** зелёный (`#176A42`).

Токен проходит насквозь, затем растворяется в ConsoleNode.

---

#### LoopNode

**Назначение:** цикл `for VAR in range(N)`.

**Пример кода:**
```python
for i in range(3):
    print(i)
```

**В графе:**
```
┌─────────────────┐
│  LOOP           │
│  i : 0 → 3      │
│  = 2            │  ← текущая итерация (обновляется в реальном времени)
└─────────────────┘
```

**Цвет:** бирюзовый (`#0E7490`).

**Два режима работы:**

1. **Тело = `print(i)`** — LoopNode генерирует N отдельных токенов (`[i=0]`, `[i=1]`, `[i=2]`), каждый идёт LOOP → PRINT → CONSOLE. Консоль накапливает вывод.

2. **Тело = вычисление** (`x = x + 1`) — один токен от предыдущего AssignmentNode приходит в LOOP. LoopNode запускает N итераций: LOOP → COMPUTE (in-place transform) → snap back to LOOP → ... → после последней итерации продолжает COMPUTE → PRINT → CONSOLE.

**Структура op:**
```javascript
{
  type: 'loop',
  variable: 'i',
  start: 0,
  end: 3,
  outputs: [],        // для print(i) внутри цикла
  bodyOps: [          // для вычислений внутри цикла
    { type: 'compute', target: 'x', expression: 'x + 1', values: [1, 2, 3] }
  ]
}
```

---

#### ConsoleNode

**Назначение:** накопитель вывода `print()`. Последний узел в каждой цепочке.

**В графе:**
```
┌─────────────────┐
│  CONSOLE        │
│  0              │
│  1              │  ← строки появляются по мере прибытия токенов
│  2              │
└─────────────────┘
```

**Цвет:** фиолетовый (`#5B35A8`).

Токен растворяется в ConsoleNode, строки появляются с анимацией fade-in.
`revealConsole` добавляет только новые строки (не перерисовывает существующие).

---

### DataToken

DataToken — капсула с данными, перемещающаяся по рёбрам графа.

**Формат отображения:**
```
[ x = 5 ]
[ i = 2 ]
[ y = 7 ]
```

**Жизненный цикл:**

```
Появление у StartNode (fade-in + scale)
        ↓
Движение к следующему узлу (gsap.to left/top, ease: power2.inOut)
        ↓
Трансформация (если ComputeNode) или транзит
        ↓
Растворение в ConsoleNode (fade-out + scale) → строки появляются
```

**`currentVar`** — мутируемое поле токена, хранящее имя переменной, которую токен сейчас представляет. Обновляется при каждой трансформации в ComputeNode. Позволяет следующему ComputeNode корректно определить, является ли операция self-update.

**Трансформации:**

| Тип | Условие | Анимация |
|-----|---------|----------|
| **self-update** | `op.target === token.currentVar` | squish (scale 0.72) → смена текста → bounce back (back.out) + amber glow |
| **rename** | другая переменная | текущий токен исчезает (scale 0.60, opacity 0), появляется новый с новым именем |

**Пример цепочки self-update в цикле:**

```
[x=0] → LOOP highlights i=0 → COMPUTE [x=0]→[x=1] → snap back
      → LOOP highlights i=1 → COMPUTE [x=1]→[x=2] → snap back
      → LOOP highlights i=2 → COMPUTE [x=2]→[x=3] → PRINT → CONSOLE
```

---

### Поддерживаемые сценарии

Все сценарии проверены в Flow Graph режиме:

**Простое присваивание:**
```python
x = 5
print(x)
```
Граф: `ASSIGN(x=5) → PRINT(x) → CONSOLE` → консоль: `5`

**Арифметика с двумя переменными:**
```python
x = 5
y = x + 2
print(y)
```
Граф: `ASSIGN(x=5) → COMPUTE(y=x+2) → PRINT(y) → CONSOLE` → консоль: `7`

**Self-update переменной:**
```python
x = 5
x = x + 1
print(x)
```
Граф: `ASSIGN(x=5) → COMPUTE(x=x+1) → PRINT(x) → CONSOLE` → консоль: `6`

**Цикл с выводом переменной цикла:**
```python
for i in range(3):
    print(i)
```
Граф: `LOOP(i:0→3) → PRINT(i) → CONSOLE`
Токены: `[i=0]`, `[i=1]`, `[i=2]` — последовательно → консоль: `0`, `1`, `2`

**Цикл с накоплением:**
```python
x = 0
for i in range(3):
    x = x + 1
print(x)
```
Граф: `ASSIGN(x=0) → LOOP(i:0→3) → COMPUTE(x=x+1) → PRINT(x) → CONSOLE`
Один токен `[x=0]` проходит 3 итерации через COMPUTE → консоль: `3`

---

### Flow Graph Status

**Реализовано:**

- ✓ AssignmentNode
- ✓ ComputeNode (бинарная арифметика с переменной)
- ✓ PrintNode
- ✓ ConsoleNode
- ✓ LoopNode (`for VAR in range(N)`)
- ✓ Обновление переменной внутри цикла (`x = x + 1`)
- ✓ DataToken с анимацией движения
- ✓ self-update трансформация (squish + bounce + glow)
- ✓ rename трансформация (fade + replace)
- ✓ Накопление вывода в ConsoleNode
- ✓ Тёмная тема
- ✓ Переключатель режимов (Classic / Flow Graph)
- ✓ Подсветка текущей итерации на LoopNode

**Планируется:**

- ConditionNode (`if / elif / else`)
- FunctionNode (`def` + вызов)
- Вложенные циклы
- Массивы и коллекции внутри тела цикла
- Несколько операций внутри тела цикла

---

## Бэкенд

### `main.py` — HTTP-сервер

Написан на встроенном `http.server` (причина: pip недоступен из-за SOCKS-прокси в среде разработки).

**Маршруты:**

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/` | Отдаёт `frontend/index.html` |
| `GET` | `/health` | `{"status": "ok"}` — проверка работоспособности |
| `GET` | `/js/*`, `/style.css` | Статические файлы фронтенда |
| `POST` | `/trace` | Валидация + трассировка кода |
| `OPTIONS` | `*` | CORS preflight |

---

### `validator.py` — AST-валидатор

Принимает исходный код, разбирает его в AST и проверяет каждый узел по whitelist. Запрещает всё, чего нет в списке разрешённого.

**Разрешённые узлы AST:** присваивание, арифметика, сравнения, булевы операторы, `if/for/while/break/continue/pass/return`, вызовы функций и методов из whitelist, списки, кортежи, словари, множества, срезы, list comprehension, определения функций.

**Явно запрещено (с понятными сообщениями):**

| Конструкция | Сообщение |
|-------------|-----------|
| `import` | Импорт модулей не разрешён |
| `global`, `nonlocal` | Не разрешён |
| `try/except`, `raise` | Не разрешён |
| `with` | Не разрешён |
| `lambda` | Lambda-функции не разрешены |
| `class` | Определение классов не разрешено |
| `async/await` | Async не разрешён |
| `yield` | Не разрешён |
| генераторы | Не разрешены |

**Возврат:** `(True, '')` при успехе или `(False, "сообщение об ошибке")`.

---

### `tracer.py` — Трассировщик

Использует `sys.settrace` для перехвата выполнения Python-кода. Генерирует события трёх типов.

**События:**

| Событие | Когда | Ключевые поля |
|---------|-------|---------------|
| `call` | При вызове пользовательской функции | `scope_id`, `parent_id`, `scope_name`, `args`, `depth` |
| `return` | При возврате из функции | `scope_id`, `scope_name`, `return_value`, `depth` |
| `line` | Перед каждой строкой | `scope_id`, `scope_name`, `line`, `variables`, `output` |

**Ключевые особенности:**

- `<module>` frame пропускает события `call`/`return` — только `line`. Это позволяет не создавать scope-блок для глобального уровня через tracer (глобальный блок создаётся отдельно на фронтенде).
- Аргументы функции (`args`) заполняются **на первом `line`-событии** внутри функции, а не на `call` — потому что в Python 3.12 `frame.f_locals` пуст в момент события `call`. Tracer ретроактивно дополняет предыдущий `call`-шаг.
- `scope_id` — уникальный номер каждого вызова функции (инкрементируется с 1). `parent_id` — `scope_id` вызывающей функции (0 = глобальная область).
- `depth` — глубина стека вызовов в момент `call` (0 = вызван из глобального кода).
- Код выполняется в изолированном namespace только с разрешёнными встроенными функциями.
- `print()` перехватывается: вывод копится в `captured_output[]`.
- Лимит: **600 line-шагов**. `call`/`return` в счётчик не входят. При превышении `truncated: true`.
- После `exec()` добавляется синтетический финальный `line`-шаг с итоговым состоянием (если оно отличается от последнего записанного).

**Сериализация значений (`_serialize`):**
- `int`, `float`, `bool`, `None` → как есть
- `str` → обрезается до 200 символов
- `list`, `tuple` → до 30 элементов, рекурсия до глубины 3
- `dict` → до 15 ключей, ключи приводятся к `str`
- `set` → до 15 элементов, сортируется
- Всё остальное → `str(value)[:100]`

---

## Фронтенд

### `index.html` — структура страницы

Одна HTML-страница с тремя view, переключаемыми через CSS-класс `active`:

- **`#input-view`** — редактор кода (CodeMirror) с переключателем режимов (Classic / Flow Graph) + карточка с описанием синтаксиса.
- **`#viz-view`** — Classic View: панель кода + сайдбар (управление + Console) + `#scope-canvas` (дерево областей видимости).
- **`#flow-graph-view`** — Flow Graph View: `#fg-canvas-wrap` с узлами, SVG-стрелками и токенами.

Оверлей **`#ball-layer`** (фиксированный, поверх всей страницы) — в него добавляются DOM-элементы летящих шариков Classic View.

---

### `api.js` — HTTP-клиент

```javascript
const API_BASE = 'http://localhost:5000';

async function traceCode(code) { ... }  // POST /trace → { steps, error, truncated }
```

---

### `editor.js` — редактор и управление view

| Функция / блок | Описание |
|----------------|----------|
| `highlightPython(raw)` | Минимальная подсветка синтаксиса для панели кода в viz-view |
| `buildCodeDisplay(code)` | Строит `#code-display` из div-ов `.code-line[data-line="N"]` |
| `setActiveLine(lineNum)` | Убирает `.active` со всех строк, ставит на нужную, scroll к ней |
| `detectTitle(code)` | Определяет заголовок визуализации по ключевым словам |
| `EXAMPLES` | Объект с 4 примерами кода: Факториал, Числа Фибоначчи, Пузырьковая сортировка, Цифры числа |
| `#example-select` | Выпадающий список в шапке карточки редактора. При выборе вставляет код и сбрасывается на placeholder |
| `visualizationMode` | Строка `'classic'` или `'flow_graph'`. Переключается кнопками `.mode-btn` |
| `applyTheme(dark)` | Ставит/снимает класс `.dark` на `<html>`, меняет иконку кнопки `🌙 ↔ ☀️` |
| `#theme-toggle` | Кнопка в хедере. Переключает тему и сохраняет выбор в `localStorage` |

**Управление с клавиатуры** (активно в viz-view Classic):
- `←` — шаг назад
- `→` — шаг вперёд
- `Space` — пауза / воспроизведение

**Выбор режима при запуске:**
```javascript
if (visualizationMode === 'flow_graph') {
  fgView.classList.add('active');
  startFlowGraph(result.steps, code);   // flow-graph.js
} else {
  vizView.classList.add('active');
  startAnimation(result.steps, result.error);  // animator.js
}
```

---

### `flow-graph.js` — движок Flow Graph

Реализует полный конвейер от шагов трассировки до анимированного графа.

#### Константы

```javascript
const FG_NODE_W   = 160;  // ширина узла (px)
const FG_NODE_H   = 80;   // высота узла (px)
const FG_GAP_X    = 60;   // зазор между узлами (px)
const FG_CENTER_Y = 130;  // Y-позиция всех узлов (px)
const FG_TOKEN_W  = 100;  // ширина токена (px)
const FG_TOKEN_H  = 32;   // высота токена (px)
```

#### Регексы

```javascript
// Детектирует бинарную арифметику: "var = operand OP operand"
const BINARY_ASSIGN_RE = /^(\w+)\s*=\s*(\w+|\d+\.?\d*)\s*([-+*/])\s*(\w+|\d+\.?\d*)\s*$/;

// Детектирует цикл for-range: "for VAR in range(N):"
const FOR_RANGE_RE = /^for\s+(\w+)\s+in\s+range\s*\(\s*(\d+)\s*\):/;
```

#### Ключевые функции

| Функция | Описание |
|---------|----------|
| `parseOps(steps, sourceLines)` | Конвертирует `steps[]` в упорядоченный список ops. Детектирует тип каждой операции, определяет bodyOps для циклов |
| `expandLoopBodyOps(ops)` | Разворачивает `loop.bodyOps` в плоский список для `buildNodes` |
| `buildNodes(expandedOps, canvasW)` | Создаёт узлы с позициями. Один узел на op |
| `buildEdges(nodes)` | Строит линейную цепочку рёбер |
| `buildTokens(ops, nodes)` | Создаёт DataToken-ы: 1 на assignment; N на loop с outputs; 0 на loop с bodyOps (токен передаётся от предыдущего assignment) |
| `renderFlowGraph(graph)` | DOM + SVG рендеринг узлов и стрелок с входной анимацией |
| `startFlowAnimation(graph)` | Запускает последовательную цепочку токенов |
| `launchToken(token, ...)` | Создаёт DOM-элемент токена и запускает его по пути |
| `walkPath(el, path, ...)` | Движение токена по ребру. Ветвится по типу целевого узла |
| `transformAtCompute(...)` | self-update / rename анимация в ComputeNode |
| `animateLoopIterations(...)` | N итераций цикла с COMPUTE: highlight → slide → transform → snap back |
| `highlightLoopIteration(nodeId, iter)` | Обновляет label LoopNode на текущую итерацию |
| `revealConsole(nodeId, lines)` | Добавляет только новые строки в ConsoleNode |
| `litNode(nodeId)` | Кратковременное свечение узла при прибытии токена |
| `pulseNode(nodeId)` | Расширяющееся кольцо при отбытии токена |
| `stopFlowAnimation()` | Убивает все таймеры и GSAP-анимации |

#### `parseOps` — детектирование типов операций

`parseOps` читает `steps[]` и строит массив ops с типами:

| Тип op | Как детектируется |
|--------|------------------|
| `assignment` | Переменная изменилась, строка — не бинарная арифметика с переменной, не loop var, не loop body |
| `compute` | Переменная изменилась + `BINARY_ASSIGN_RE` совпало + хотя бы один операнд — переменная (не чистый литерал) |
| `loop` | Переменная — loop var (найдена через `FOR_RANGE_RE` в sourceLines). Emits один раз |
| `print` | Вырос буфер `output[]`. Если переменная — loop var → идёт в `loop.outputs`. Если нет → отдельный op |
| loop `bodyOp` | Переменная изменилась на строке с `prevLineIdx ∈ loopBodyLineNums` → собирается в `loop.bodyOps[].values` |

Ключевой инвариант: `prevLineIdx` — номер строки, которая **только что выполнилась** (не текущей). `loopBodyLineNums` строится заранее по отступам исходного кода (требует не-trim'd sourceLines).

---

### `animator.js` — движок анимации Classic View

Главный модуль Classic View. Управляет воспроизведением шагов, деревом scope-блоков, SVG-стрелками и анимацией шариков.

#### Состояние

```javascript
let steps            = [];   // массив шагов от tracer
let currentStep      = 0;    // текущий индекс
let isPlaying        = false;
let playTimer        = null; // setTimeout handle
let prevVars         = {};   // переменные предыдущего шага (для diff)
let prevOutput       = [];   // вывод предыдущего шага
let precomputedPositions = new Map(); // scopeId → { x, y } (дерево)
let pendingRootX     = -1;   // x-координата корня для авто-прокрутки
```

#### Константы

```javascript
const BLOCK_W      = 200;   // ширина scope-блока (px)
const BLOCK_GAP_X  = 28;    // горизонтальный зазор между блоками
const BLOCK_GAP_Y  = 165;   // вертикальный зазор между уровнями
const BLOCK_PAD_Y  = 16;    // отступ сверху для глобального блока

const BALL_DELAY    = 200;  // мс: пауза перед стартом шарика
const BALL_FLY_MS   = 480;  // мс: время полёта (соответствует GSAP duration 0.45s)
const NO_BALL_PAUSE = 250;  // мс: пауза если в шаге нет изменений
```

#### Скорость воспроизведения

Значение `<select>` = пауза после приземления шарика перед переходом к следующей строке.

| Опция | postPause | Шаг без шара | Шаг с шаром |
|-------|-----------|--------------|-------------|
| Медленно | 800 мс | 250 мс | ~1480 мс |
| Нормально | 300 мс | 250 мс | ~980 мс |
| Быстро | 50 мс | 250 мс | ~730 мс |
| Очень быстро | 0 мс | **125 мс** | **~300 мс** |

В режиме **«Очень быстро»** (`postPause === 0`) все задержки вдвое меньше: `BALL_DELAY → 80 мс`, время полёта GSAP `0.45s → 0.22s`, пауза без шара `→ 125 мс`.

#### Ключевые функции

**`precomputeTreeLayout(steps)`**

Перед стартом анимации обходит все `call`-шаги и строит позиции scope-блоков методом Рейнгольда–Тилфорда:
- Листья расставляются слева направо через `leafIdx * (BLOCK_W + BLOCK_GAP_X)`
- Родители центрируются над первым и последним дочерним блоком
- Глубина 0 → `y = BLOCK_GAP_Y + BLOCK_PAD_Y = 181px` (одна строка ниже глобального блока, чтобы не конфликтовать по x)
- Центроид верхнеуровневых вызовов сохраняется в `pendingRootX` для авто-прокрутки

**`expandCanvas()` + авто-прокрутка**

После каждого добавления блока пересчитывает `minWidth`/`minHeight` canvas. Когда ширина контента впервые превысит `clientWidth + 50px`, применяет `pendingRootX` как `scrollLeft` — так пользователь видит корень дерева, а не пустое начало.

**`renderStep(index, onDone)`**

Обрабатывает шаг по типу события:
- `call` → `createScopeBlock(...)` (создаёт DOM-блок, рисует стрелку)
- `return` → `markScopeReturned(...)` (блок → `done`, показывает `ret: value`)
- `line` → подсвечивает строку, обновляет переменные и Console в scope-блоке

**`scheduleNextStep()`**

Главный цикл авто-воспроизведения. Look-ahead логика:
1. Для `call`/`return` шагов — короткая пауза, никаких шариков
2. Для `line` шагов — сравнивает `steps[N]` и `steps[N+1]`, запускает шарики от текущей строки к scope-блоку; переменные обновляются при приземлении

**`animateBall(fromEl, toEl, color, onComplete, fast)`**

Создаёт DOM-элемент шарика в `#ball-layer`, анимирует через GSAP. Параметр `fast=true` → `duration: 0.22s` вместо `0.45s`. Дополнительно: 3 trail-точки.

**`fireReturnBall(childScopeId, retVal, fast)`**

Запускает фиолетовый шарик `#8B5CF6` от блока дочерней функции к блоку родительской — визуализирует возврат значения.

---

## Дерево областей видимости

### Scope-блоки (`#scope-canvas`)

`#scope-canvas` — прокручиваемый (overflow: auto) контейнер на всю ширину под панелью кода. Внутри — абсолютно позиционированные `.scope-block` и SVG-слой `#scope-arrows` с безье-стрелками.

**Состояния блока:**

| Класс | Смысл |
|-------|-------|
| `.active` | Выполнение сейчас в этой функции |
| `.waiting` | Вызов сделан, ждёт возврата дочерней функции |
| `.done` | Функция завершена, показывает `ret: значение` |

**Структура блока:**
```
┌─────────────────────┐
│  f(n=5)             │  ← .scope-block-header (имя + аргументы)
├─────────────────────┤
│  [n] [result]       │  ← .scope-block-vars (var-card'ы)
├─────────────────────┤
│  ret: 120           │  ← .scope-block-return (только у .done)
└─────────────────────┘
```

### Глобальный блок

Создаётся функцией `ensureGlobalBlock()` при первом `line`-событии. Всегда на `x=0, y=16` (верхний левый угол canvas). `scope_id = 0`.

### Алгоритм центрированного дерева

```
Уровень  y (px)
  0      16    ← Глобальный блок
  1      181   ← Функции глубины 0 (вызваны из глобального кода)
  2      346   ← Функции глубины 1
  3      511   ← ...
```

Функции глубины 0 на `y=181` (строка 1) — на строку ниже глобального блока. Это позволяет им расти в любую сторону по x без конфликта с глобальным блоком.

### SVG-стрелки

Каждая стрелка — кубическая безье-кривая от нижней границы родительского блока до верхней дочернего:

```
M px,py  C px,py+40  cx,cy-40  cx,cy
```

`py = p.y + p.el.offsetHeight` — реальная нижняя граница (динамическая, т.к. блок растёт при добавлении переменных). `redrawAllArrows()` вызывается после каждого изменения высоты блока.

---

## Доступный синтаксис

### Разрешено

**Переменные и присваивание**
```python
x = 5
x += 1
a, b = 1, 2       # распаковка
x: int = 5        # аннотация типа
```

**Условия**
```python
if x > 0:
    pass
elif x == 0:
    pass
else:
    pass
```

**Циклы**
```python
for i in range(10):
    break

while x > 0:
    continue
```

**Функции**
```python
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)
```

**Структуры данных**
```python
lst = [1, 2, 3]
tpl = (1, 2)
dct = {'a': 1}
st  = {1, 2, 3}
lst[0]               # индексация
lst[1:3]             # срез
[x*2 for x in lst]  # list comprehension
```

**Встроенные функции**

`print`, `range`, `len`, `int`, `float`, `str`, `bool`, `abs`, `min`, `max`, `sum`, `round`, `bin`, `sorted`, `reversed`, `list`, `tuple`, `dict`, `set`, `enumerate`, `zip`, `type`

**Методы**

| Тип | Методы |
|-----|--------|
| Список | `append`, `pop`, `insert`, `remove`, `sort`, `reverse`, `count`, `index`, `extend`, `clear`, `copy` |
| Строка | `upper`, `lower`, `strip`, `split`, `join`, `replace`, `find`, `startswith`, `endswith` |
| Словарь | `keys`, `values`, `items`, `get` |

### Запрещено

`import`, `class`, `lambda`, `try/except`, `raise`, `with`, `async/await`, `yield`, генераторы, `global`, `nonlocal`, `del`

### Лимит

Максимум **600 line-шагов** трассировки. `call` и `return` в счётчик не входят. При превышении показывается предупреждение.

---

## API

### `POST /trace`

**Запрос:**
```http
POST http://localhost:5000/trace
Content-Type: application/json

{ "code": "def f(n):\n    return n*2\nprint(f(5))" }
```

**Ответ (успех):**
```json
{
  "steps": [
    {
      "event": "line",
      "scope_id": 0,
      "scope_name": "<module>",
      "depth": 0,
      "line": 3,
      "variables": {},
      "output": []
    },
    {
      "event": "call",
      "scope_id": 1,
      "parent_id": 0,
      "scope_name": "f",
      "args": { "n": 5 },
      "depth": 0,
      "line": 1,
      "variables": { "n": 5 },
      "output": []
    },
    {
      "event": "line",
      "scope_id": 1,
      "scope_name": "f",
      "depth": 0,
      "line": 2,
      "variables": { "n": 5 },
      "output": []
    },
    {
      "event": "return",
      "scope_id": 1,
      "scope_name": "f",
      "return_value": 10,
      "depth": 0,
      "line": 2,
      "variables": { "n": 5 },
      "output": []
    },
    {
      "event": "line",
      "scope_id": 0,
      "scope_name": "<module>",
      "depth": 0,
      "line": 3,
      "variables": {},
      "output": ["10"],
      "final": true
    }
  ],
  "error": null,
  "truncated": false,
  "total_lines": 3
}
```

**Ответ (ошибка валидации):**
```json
{
  "steps": [],
  "error": {
    "type": "ValidationError",
    "message": "Импорт модулей не разрешён",
    "line": null
  },
  "truncated": false
}
```

**Поля шага:**

| Поле | Тип | События | Описание |
|------|-----|---------|----------|
| `event` | `string` | все | `"line"`, `"call"` или `"return"` |
| `scope_id` | `int` | все | Уникальный ID области видимости (0 = глобальная) |
| `scope_name` | `string` | все | Имя функции или `"<module>"` |
| `depth` | `int` | все | Глубина стека (0 = вызван из глобального кода) |
| `line` | `int` | все | Номер строки (1-based) |
| `variables` | `object` | все | Снимок локальных переменных |
| `output` | `string[]` | все | Накопленный вывод `print()` |
| `parent_id` | `int` | `call` | `scope_id` вызывающей функции |
| `args` | `object` | `call` | Аргументы на момент входа в функцию |
| `return_value` | `any` | `return` | Возвращаемое значение |
| `final` | `bool?` | `line` | `true` только у синтетического последнего шага |

---

## Тёмная тема

Реализована через CSS-класс `.dark` на `<html>`:

```javascript
document.documentElement.classList.toggle('dark', isDark);
localStorage.setItem('theme', isDark ? 'dark' : 'light');
```

При загрузке страницы тема восстанавливается из `localStorage`. Кнопка `🌙 / ☀️` находится в шапке.

В `style.css`:
- `.dark { ... }` — переопределяет все 16 CSS-переменных
- Hardcode-значения (10+ правил) перекрыты через `.dark .selector`
- CodeMirror темизируется CSS-переопределениями токенов (`.cm-keyword`, `.cm-string` и др.)
- Анимация `ret-flash` переопределена как отдельный `@keyframes ret-flash-dark`
- `transition: 0.25s` на основных элементах для плавного переключения
- Flow Graph узлы имеют собственные `.fg-node--TYPE` классы с тёмным фоном (работают в обеих темах)

---

## Технические решения

### Почему встроенный HTTP-сервер, а не FastAPI

pip недоступен в среде разработки (SOCKS-прокси блокирует установку пакетов). Бэкенд переписан на `http.server`, `json`, `os` — нулевые зависимости.

### Сдвиг sys.settrace (off-by-one)

`sys.settrace` даёт событие `line` **перед** выполнением строки. Снимок в шаге N содержит переменные, установленные строкой N-1.

- **Classic View** решает это через look-ahead: `scheduleNextStep` сравнивает `steps[N]` и `steps[N+1]`, запускает шарик от текущей подсвеченной строки (которая и производит изменения), а панели обновляет при приземлении шарика.
- **Flow Graph** использует `prevLineIdx` (номер строки из предыдущего шага) для определения типа операции: `sourceLines[prevLineIdx - 1]` — это строка, которая **только что** выполнилась и произвела изменение переменных.

### Loop body detection в parseOps

Для корректного определения тела цикла `flow-graph.js` принимает **не-trim'd** исходные строки (иначе нельзя определить отступ). `loopBodyLineNums` строится заранее:

```javascript
const forIndent = line.length - line.trimStart().length;
for (let j = i + 1; j < sourceLines.length; j++) {
  if (bl.length - bl.trimStart().length > forIndent) loopBodyLineNums.add(j + 1);
  else break;
}
```

Затем в каждом шаге: `isBodyLine = loopBodyLineNums.has(prevLineIdx)`. Если `isBodyLine === true` и переменная изменилась — это не отдельный op, а `bodyOp` внутри loop op с накоплением `values[]`.

### expandLoopBodyOps — плоский граф из вложенной структуры

`buildNodes` работает с плоским массивом (один op → один узел). Но loop op содержит вложенные bodyOps. `expandLoopBodyOps` превращает:

```
[assign, loop{bodyOps:[compute]}, print]
```

в:

```
[assign, loop, compute, print]
```

не копируя объекты — только расставляя ссылки. Поэтому `opToNodeId = new Map(node._op → node.id)` работает через идентичность ссылок.

### Пустые аргументы на call-событии (Python 3.12)

В Python 3.12 `frame.f_locals` возвращает пустой словарь в момент события `call`. Tracer откладывает заполнение `args` до первого `line`-события внутри функции и ретроактивно дополняет предыдущий `call`-шаг: `steps[call_idx]['args'] = copy.deepcopy(local_vars)`.

### Центрированное дерево — почему depth+1

Глобальный блок (`y=16`) и функции глубины 0 (`depth=0`) раньше были на одном уровне y. Это вынуждало функции стоять правее `x=200`, и всё дерево росло только вправо. Решение: функции начинаются с `y = (depth+1) * 165 + 16`, то есть со строки 1, а глобальный блок — строка 0. Они никогда не пересекаются по y, функции свободно расходятся влево и вправо.

### Авто-прокрутка к корню

Корень дерева может оказаться далеко от x=0 (при большом числе листьев). Простой `setTimeout` не работал: canvas ещё не был достаточно широким, `scrollLeft` игнорировался. Решение: `pendingRootX` хранит x-координату центроида верхнеуровневых вызовов. `expandCanvas()` применяет `scrollLeft` только тогда, когда `maxRight > clientWidth + 50` — то есть когда canvas реально стал шире viewport.

### Синтетический финальный шаг

После `exec()` в namespace могут остаться изменения, которые `settrace` не успел зафиксировать (последняя строка). Поэтому `tracer.py` добавляет дополнительный `line`-шаг с финальным состоянием, если оно отличается от последнего записанного. Не добавляется при ошибке или усечении.

### Ghost-якорь консоли

Цель шарика для Console — `#console-anchor`, нулевой div в конце `#console-body`. Проблема: `innerHTML = ''` уничтожает его. Решение: модульная JS-переменная `const consoleAnchor = document.getElementById('console-anchor')` хранит ссылку, и все функции очистки восстанавливают его через `consoleBody.appendChild(consoleAnchor)`.

### CP1251 и Windows-терминал

В `log_message` убраны Unicode-символы — они вызывали `UnicodeEncodeError` в CP1251-консоли Windows и крашили обработчик запроса до отправки ответа.

### FG_NODE_TYPES / FG_COLORS — реестр без if-цепочек

Flow Graph использует два объекта-реестра вместо if/switch по типу узла:

```javascript
const FG_NODE_TYPES = {
  assignment: { typeLabel: 'ASSIGN',   makeLabel: (op) => `${op.varName} = ${fgFmtVal(op.value)}` },
  compute:    { typeLabel: 'COMPUTE',  makeLabel: (op) => `${op.target} = ${op.expression}` },
  print:      { typeLabel: 'PRINT',    makeLabel: (op) => op.label },
  loop:       { typeLabel: 'LOOP',     makeLabel: (op) => `${op.variable} : ${op.start} → ${op.end}` },
  console:    { typeLabel: 'CONSOLE',  makeLabel: (_op) => '' },
};
```

Добавление нового типа — только одна запись в `FG_NODE_TYPES` и одна в `FG_COLORS`. `renderFlowGraph`, `litNode`, `pulseNode` работают с любым типом автоматически.

---

## Release Notes

### v1.2.0

**Flow Graph View — первый релиз**

- Добавлен новый режим визуализации **Flow Graph** (кнопка «Flow Graph» в переключателе, помечена «Experimental»).
- Реализован полный конвейер: `parseOps → expandLoopBodyOps → buildNodes → buildEdges → buildTokens → renderFlowGraph → startFlowAnimation`.
- Реализован **AssignmentNode** — простое присваивание, генерирует DataToken.
- Реализован **ComputeNode** — бинарная арифметика. Два типа трансформации токена: self-update (squish+bounce+glow) и rename (fade-replace).
- Реализован **PrintNode** — транзитный узел перед Console.
- Реализован **ConsoleNode** — накопитель вывода с инкрементальным reveal.
- Реализован **LoopNode** (`for VAR in range(N)`):
  - Режим `print(i)` — N отдельных итерационных токенов, консоль накапливает вывод построчно.
  - Режим `x = x + 1` — один токен проходит N итераций через COMPUTE с in-place обновлением, затем продолжает к PRINT и CONSOLE.
  - Текущая итерация отображается на LoopNode в реальном времени.
- Реализована **анимация DataToken**: движение по рёбрам, трансформации, растворение в Console.
- Реализована автоматическая прокрутка canvas при большом числе узлов.
- Исправлен лимит шагов в документации: было 300, актуальное значение **600** (`MAX_STEPS = 600` в `tracer.py`).
- Classic View не затронут.

### v1.1.0

- Добавлена тёмная тема (CSS-переменные + `localStorage`).
- Добавлена поддержка рекурсивных функций в дереве scope-блоков.
- Добавлены примеры кода (Факториал, Фибоначчи, Пузырьковая сортировка, Цифры числа).
- Добавлена функция `bin()` в whitelist бэкенда.
- Добавлен переключатель скорости «Очень быстро».

### v1.0.0

- Первый публичный релиз.
- Classic View с пошаговой анимацией (scope-блоки, шарики, Console).
- Бэкенд на встроенных модулях Python (без pip).
- AST-валидатор с whitelist.
- Трассировщик на `sys.settrace`.
- Подсветка синтаксиса Python в панели кода.
- Светлая тема.
