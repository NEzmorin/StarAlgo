/* StarAlgo unified Python runner.
 * Python code always runs in an opaque-origin sandboxed iframe.
 * The cloud/auth bridge is intentionally not modified.
 */
(() => {
  'use strict';

  const PYODIDE_VERSION = '314.0.7';
  const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v' + PYODIDE_VERSION + '/full/';
  const OUTPUT_LIMIT = 50000;
  const MAX_CODE_LENGTH = 200000;
  const RUN_TIMEOUT_MS = 90000;
  const GAME_TIMEOUT_MS = 600000;
  let activeRunCleanup = null;

  function createToken() {
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }

  function encodeUtf8Base64(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function buildSandboxDocument(token, encodedCode, mode) {
    const policy = [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
      'connect-src https://cdn.jsdelivr.net https://pypi.org https://files.pythonhosted.org',
      "style-src 'unsafe-inline'",
      'img-src data: blob:',
      'font-src data:',
      'media-src data: blob:',
      "worker-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ');

    const displayBootstrap = [
      'import io as _sa_io',
      'import base64 as _sa_base64',
      '__staralgo_images = []',
      'def display(obj):',
      '    if not callable(getattr(obj, "save", None)):',
      '        print(obj)',
      '        return',
      '    if len(__staralgo_images) >= 4:',
      '        print("StarAlgo: лимит изображений — 4.")',
      '        return',
      '    _buffer = _sa_io.BytesIO()',
      '    obj.save(_buffer, format="PNG")',
      '    _raw = _buffer.getvalue()',
      '    if len(_raw) > 1500000:',
      '        raise ValueError("Изображение больше лимита StarAlgo (1.5 МБ).")',
      '    __staralgo_images.append("data:image/png;base64," + _sa_base64.b64encode(_raw).decode("ascii"))'
    ].join('\n');

    const matplotlibBootstrap = [
      'import matplotlib as _sa_matplotlib',
      '_sa_matplotlib.use("Agg", force=True)',
      'import matplotlib.pyplot as _sa_plt',
      '__staralgo_seen_figures = set()',
      'def __staralgo_capture_figures():',
      '    for _number in _sa_plt.get_fignums():',
      '        if _number in __staralgo_seen_figures:',
      '            continue',
      '        if len(__staralgo_images) >= 4:',
      '            break',
      '        _buffer = _sa_io.BytesIO()',
      '        _sa_plt.figure(_number).savefig(_buffer, format="png", bbox_inches="tight")',
      '        _raw = _buffer.getvalue()',
      '        if len(_raw) > 1500000:',
      '            print("StarAlgo: график пропущен — размер больше 1.5 МБ.")',
      '            __staralgo_seen_figures.add(_number)',
      '            continue',
      '        __staralgo_images.append("data:image/png;base64," + _sa_base64.b64encode(_raw).decode("ascii"))',
      '        __staralgo_seen_figures.add(_number)',
      'def __staralgo_plot_show(*args, **kwargs):',
      '    __staralgo_capture_figures()',
      '_sa_plt.show = __staralgo_plot_show'
    ].join('\n');

    const pgzeroBootstrap = [
      'import asyncio as _sa_asyncio',
      'import os as _sa_os',
      'import sys as _sa_sys',
      'import types as _sa_types',
      'import time as _sa_time',
      'import pygame as _sa_pygame',
      '_sa_os.makedirs("/home/pyodide", exist_ok=True)',
      '_sa_game_path = "/home/pyodide/main.py"',
      'with open(_sa_game_path, "w", encoding="utf-8") as _sa_game_file:',
      '    _sa_game_file.write(__staralgo_user_source)',
      'if "pyfxr" not in _sa_sys.modules:',
      '    _sa_pyfxr = _sa_types.ModuleType("pyfxr")',
      '    class _StarAlgoWaveform:',
      '        @staticmethod',
      '        def sine(): return "sine"',
      '        @staticmethod',
      '        def square(): return "square"',
      '        @staticmethod',
      '        def saw(): return "saw"',
      '        @staticmethod',
      '        def triangle(): return "triangle"',
      '    _sa_pyfxr.Wavetable = _StarAlgoWaveform',
      '    def _sa_pyfxr_unavailable(*args, **kwargs):',
      '        raise RuntimeError("Генерация tone.* пока не поддерживается в браузерной сборке StarAlgo. Используй подготовленные звуковые файлы.")',
      '    _sa_pyfxr.tone = _sa_pyfxr_unavailable',
      '    _sa_pyfxr.note_to_hertz = _sa_pyfxr_unavailable',
      '    _sa_sys.modules["pyfxr"] = _sa_pyfxr',
      '_sa_pgzrun = _sa_types.ModuleType("pgzrun")',
      '_sa_pgzrun.go = lambda: None',
      '_sa_sys.modules["pgzrun"] = _sa_pgzrun',
      'from pgzero.runner import prepare_mod as _sa_prepare_mod',
      'from pgzero.game import PGZeroGame as _sa_PGZeroGame',
      // Browser Canvas has no native window icon resource; skip PGZero's default-icon loader.
      '_sa_PGZeroGame.show_default_icon = staticmethod(lambda: None)',
      'from pgzero import clock as _sa_pgzero_clock',
      '_sa_mod = _sa_types.ModuleType("staralgo_game")',
      '_sa_mod.__file__ = _sa_game_path',
      '_sa_mod.__name__ = "staralgo_game"',
      '_sa_prepare_mod(_sa_mod)',
      'import pgzero.tone as _sa_pgzero_tone',
      'def _sa_tone_unavailable(*args, **kwargs):',
      '    raise RuntimeError("tone.play/create пока недоступны в браузерной сборке StarAlgo. Используй файлы из папки sounds.")',
      '_sa_pgzero_tone.play = _sa_tone_unavailable',
      '_sa_pgzero_tone.create = _sa_tone_unavailable',
      'exec(compile(__staralgo_user_source, _sa_game_path, "exec"), _sa_mod.__dict__)',
      '_sa_game = _sa_PGZeroGame(_sa_mod)',
      '_sa_game.reinit_screen()',
      '_sa_update = _sa_game.get_update_func()',
      '_sa_draw = _sa_game.get_draw_func()',
      '_sa_game.load_handlers()',
      '_sa_game.need_redraw = True',
      '_sa_draw()',
      '_sa_pygame.display.flip()',
      'async def _sa_run_pgzero_loop():',
      '    _sa_last = _sa_time.perf_counter()',
      '    _sa_running = True',
      '    while _sa_running:',
      '        _sa_frame_start = _sa_time.perf_counter()',
      '        _sa_dt = max(0.0, min(_sa_frame_start - _sa_last, 0.1))',
      '        _sa_last = _sa_frame_start',
      '        for _sa_event in _sa_pygame.event.get():',
      '            if _sa_event.type == _sa_pygame.QUIT:',
      '                _sa_running = False',
      '                continue',
      '            if _sa_event.type == _sa_pygame.KEYDOWN:',
      '                _sa_game.keyboard._press(_sa_event.key)',
      '            elif _sa_event.type == _sa_pygame.KEYUP:',
      '                _sa_game.keyboard._release(_sa_event.key)',
      '            _sa_game.dispatch_event(_sa_event)',
      '        _sa_pgzero_clock.clock.tick(_sa_dt)',
      '        if _sa_update:',
      '            _sa_update(_sa_dt)',
      '        _sa_screen_changed = _sa_game.reinit_screen()',
      '        if _sa_screen_changed or _sa_update or _sa_pgzero_clock.clock.fired or _sa_game.need_redraw:',
      '            _sa_draw()',
      '            _sa_pygame.display.flip()',
      '            _sa_game.need_redraw = False',
      '        _sa_remaining = (1.0 / 60.0) - (_sa_time.perf_counter() - _sa_frame_start)',
      '        await _sa_asyncio.sleep(max(0.0, _sa_remaining))',
      'try:',
      '    await _sa_run_pgzero_loop()',
      'except (SystemExit, KeyboardInterrupt):',
      '    print("Pygame Zero: игра остановлена.")',
      'finally:',
      '    _sa_pgzero_clock.clock.events.clear()',
      '    _sa_pgzero_clock.clock._each_tick.clear()',
      '    _sa_pgzero_clock.clock.t = 0',
      '    _sa_pgzero_clock.clock.fired = False',
      '    _sa_pygame.display.quit()',
      '    try:',
      '        _sa_pygame.mixer.quit()',
      '    except Exception:',
      '        pass'
    ].join('\n');

    return [
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
      '<meta name="referrer" content="no-referrer">',
      '<meta http-equiv="Content-Security-Policy" content="' + policy + '">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<style>html,body{margin:0;min-height:100%;font:14px monospace;background:#fff;color:#222}body{padding:12px;box-sizing:border-box}#status{color:#765f16;margin-bottom:8px}small{color:#666}#visual-output{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:8px}#visual-output img{display:block;max-width:100%;max-height:65vh;object-fit:contain;border:1px solid #ddd}#canvas{display:block;width:100%;height:auto;max-height:70vh;min-height:200px;background:#111;border:1px solid #bbb;touch-action:none}</style>',
      '<script src="' + PYODIDE_BASE + 'pyodide.js"><' + '/script>',
      '</head><body><div id="status">Загрузка изолированной среды Pyodide…</div>',
      (mode === 'pygame' || mode === 'pgzero') ? '<canvas id="canvas" width="640" height="360" tabindex="0" aria-label="Окно Pygame"></canvas>' : '',
      '<div id="visual-output"></div>',
      '<small>StarAlgo · CPython через WebAssembly · изолированный запуск</small>',
      '<script>',
      '(async function(){',
      '  const TOKEN = ' + JSON.stringify(token) + ';',
      '  const MODE = ' + JSON.stringify(mode) + ';',
      '  const encoded = ' + JSON.stringify(encodedCode) + ';',
      '  const binary = atob(encoded);',
      '  const bytes = new Uint8Array(binary.length);',
      '  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);',
      '  const source = new TextDecoder().decode(bytes);',
      '  const status = document.getElementById("status");',
      '  let output = "";',
      '  let truncated = false;',
      '  function send(kind, payload) {',
      '    parent.postMessage(Object.assign({type:"staralgo-pyodide", token:TOKEN, kind:kind}, payload || {}), "*");',
      '  }',
      '  function append(value) {',
      '    const part = String(value == null ? "" : value);',
      '    const remaining = ' + OUTPUT_LIMIT + ' - output.length;',
      '    if (remaining > 0) output += part.slice(0, remaining);',
      '    if (part.length > remaining) truncated = true;',
      '  }',
      '  try {',
      '    if (typeof loadPyodide !== "function") throw new Error("Не удалось загрузить Pyodide с CDN.");',
      '    send("status", {message:"Загрузка CPython " + ' + JSON.stringify(PYODIDE_VERSION) + ' + "…"});',
      '    const pyodide = await loadPyodide({indexURL:' + JSON.stringify(PYODIDE_BASE) + '});',
      '    pyodide.setStdout({batched:function(line){append(line + "\\n");}});',
      '    pyodide.setStderr({batched:function(line){append(line + "\\n");}});',
      '    if (MODE === "pygame" || MODE === "pgzero") {',
      '      if (!pyodide.canvas || typeof pyodide.canvas.setCanvas2D !== "function") throw new Error("Эта сборка Pyodide не предоставляет SDL Canvas API.");',
      '      if (pyodide._api) pyodide._api._skip_unwind_fatal_error = true;',
      '      pyodide.canvas.setCanvas2D(document.getElementById("canvas"));',
      '      send("status", {message:"Подготовка игрового Canvas и SDL…"});',
      '    }',
      '    send("status", {message:MODE === "pgzero" ? "Загрузка Pygame Zero и игровых библиотек…" : "Проверка импортов и загрузка доступных библиотек…"});',
      '    if (MODE === "pgzero") {',
      '      await pyodide.loadPackage(["micropip", "pygame-ce", "numpy"]);',
      '      await pyodide.runPythonAsync("import micropip\\nawait micropip.install(\'pgzero==1.2.1\', deps=False)");',
      '      const importProbe = source.replace(/^\\s*#!\\s*pgzrun.*$/gm, "").replace(/^\\s*(?:import\\s+pgzrun\\b|(?:import|from)\\s+pgzero\\b).*$/gm, "");',
      '      if (importProbe.trim()) await pyodide.loadPackagesFromImports(importProbe);',
      '    } else {',
      '      await pyodide.loadPackagesFromImports(source);',
      '    }',
      '    pyodide.runPython(' + JSON.stringify(displayBootstrap) + ');',
      '    if (/\\b(?:import\\s+matplotlib|from\\s+matplotlib)\\b/.test(source)) {',
      '      pyodide.runPython(' + JSON.stringify(matplotlibBootstrap) + ');',
      '    }',
      '    send("status", {message:MODE === "pgzero" ? "Pygame Zero готов. Запуск игры…" : MODE === "pygame" ? "Pygame готов. Запуск программы…" : "Библиотеки готовы. Выполнение программы…"});',
      '    let result;',
      '    if (MODE === "pgzero") {',
      '      const canvas = document.getElementById("canvas");',
      '      if (canvas) canvas.addEventListener("pointerdown", function(){canvas.focus();});',
      '      pyodide.globals.set("__staralgo_user_source", source);',
      '      result = await pyodide.runPythonAsync(' + JSON.stringify(pgzeroBootstrap) + ');',
      '    } else {',
      '      result = await pyodide.runPythonAsync(source);',
      '    }',
      '    if (result && typeof result.destroy === "function") result.destroy();',
      '    if (/\\b(?:import\\s+matplotlib|from\\s+matplotlib)\\b/.test(source)) pyodide.runPython("__staralgo_capture_figures()");',
      '    const imagesProxy = pyodide.globals.get("__staralgo_images");',
      '    if (imagesProxy && typeof imagesProxy.toJs === "function") {',
      '      const images = imagesProxy.toJs();',
      '      imagesProxy.destroy();',
      '      const visual = document.getElementById("visual-output");',
      '      for (const imageSource of images.slice(0, 4)) {',
      '        if (typeof imageSource !== "string" || !imageSource.startsWith("data:image/png;base64,")) continue;',
      '        const image = document.createElement("img");',
      '        image.alt = "Результат Python";',
      '        image.src = imageSource;',
      '        visual.appendChild(image);',
      '      }',
      '    }',
      '    const version = pyodide.runPython("import sys; sys.version");',
      '    if (truncated) output += "\\n[Вывод обрезан: достигнут лимит 50 000 символов.]";',
      '    status.textContent = (MODE === "pygame" || MODE === "pgzero") ? "Игра завершена. Игровое окно оставлено для просмотра." : "Выполнение завершено."; ',
      '    send("done", {ok:true, output:output, pythonVersion:String(version)});',
      '  } catch (error) {',
      '    append((output ? "\\n" : "") + String(error && (error.stack || error.message) || error));',
      '    if (truncated) output += "\\n[Вывод обрезан: достигнут лимит 50 000 символов.]";',
      '    status.textContent = "Ошибка выполнения Python. Подробности — в консоли StarAlgo.";',
      '    send("done", {ok:false, output:output || "Ошибка запуска Pyodide."});',
      '  }',
      '})();',
      '<' + '/script></body></html>'
    ].join('');
  }

  function showNotice(message) {
    const canvasBox = document.getElementById('turtle-graphics-canvas-container');
    const outputBox = document.getElementById('python-console-output');
    if (activeRunCleanup) activeRunCleanup(true);
    if (typeof window.stopPythonSandbox === 'function') window.stopPythonSandbox();
    if (canvasBox) {
      canvasBox.replaceChildren();
      const note = document.createElement('div');
      note.style.cssText = 'padding:14px;color:#222;font:14px/1.5 monospace;white-space:pre-wrap;text-align:left;';
      note.textContent = message;
      canvasBox.appendChild(note);
    }
    if (outputBox) {
      outputBox.textContent = message;
      outputBox.style.color = '#d4b236';
    }
  }

  window.runPythonPyodideSandbox = function(code, options) {
    const canvasBox = document.getElementById('turtle-graphics-canvas-container');
    const outputBox = document.getElementById('python-console-output');
    const source = String(code || '');
    const mode = options && (options.mode === 'pygame' || options.mode === 'pgzero') ? options.mode : 'python';

    if (!canvasBox || !outputBox) return;
    if (source.length > MAX_CODE_LENGTH) {
      outputBox.textContent = 'Код слишком большой для запуска (лимит 200 КБ).';
      outputBox.style.color = '#ff5555';
      return;
    }

    if (activeRunCleanup) activeRunCleanup(true);
    if (typeof window.stopPythonSandbox === 'function') window.stopPythonSandbox();

    canvasBox.replaceChildren();
    const frame = document.createElement('iframe');
    frame.title = (mode === 'pygame' || mode === 'pgzero') ? 'Изолированная игровая среда Python' : 'Изолированная среда Pyodide';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'display:block;width:100%;height:100%;min-height:280px;border:0;background:#fff;';
    canvasBox.appendChild(frame);

    const token = createToken();
    let timeoutId = 0;
    let observer = null;
    let finished = false;

    const cleanup = (removeFrame) => {
      if (finished) {
        if (removeFrame && frame.parentNode) frame.remove();
        if (removeFrame && activeRunCleanup === cleanup) activeRunCleanup = null;
        return;
      }
      finished = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      if (observer) observer.disconnect();
      if (removeFrame && frame.parentNode) frame.remove();
      if (activeRunCleanup === cleanup && removeFrame) activeRunCleanup = null;
    };

    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== 'staralgo-pyodide' || data.token !== token) return;

      if (data.kind === 'status') {
        outputBox.textContent = String(data.message || 'Pyodide выполняет программу…');
        outputBox.style.color = '#d4b236';
        return;
      }

      if (data.kind === 'done') {
        const output = String(data.output == null ? '' : data.output).slice(0, OUTPUT_LIMIT);
        outputBox.textContent = output || (data.ok ? 'Скрипт выполнен успешно!' : 'Выполнение завершено с ошибкой.');
        if (data.pythonVersion) outputBox.textContent += '\n\n[Pyodide ' + PYODIDE_VERSION + ' · ' + data.pythonVersion + ']';
        outputBox.style.color = data.ok ? '#55ff55' : '#ff5555';
        outputBox.scrollTop = outputBox.scrollHeight;
        cleanup(false);
      }
    };

    activeRunCleanup = cleanup;
    window.addEventListener('message', onMessage);
    observer = new MutationObserver(() => {
      if (!canvasBox.isConnected) cleanup(true);
    });
    observer.observe(document.body, {childList:true, subtree:true});

    const timeout = (mode === 'pygame' || mode === 'pgzero') ? GAME_TIMEOUT_MS : RUN_TIMEOUT_MS;
    timeoutId = window.setTimeout(() => {
      outputBox.textContent = mode === 'pygame'
        ? 'Игровой запуск остановлен по лимиту 10 минут.'
        : 'Pyodide остановлен по тайм-ауту (90 секунд). Возможно, программа зациклилась.';
      outputBox.style.color = '#ff5555';
      cleanup(true);
      canvasBox.replaceChildren();
      const note = document.createElement('div');
      note.style.cssText = 'padding:12px;color:#333;font:13px monospace;';
      note.textContent = 'Выполнение остановлено по ограничению времени.';
      canvasBox.appendChild(note);
    }, timeout);

    outputBox.textContent = 'Загрузка Pyodide ' + PYODIDE_VERSION + '… Первый запуск может занять больше времени.';
    outputBox.style.color = '#d4b236';
    frame.srcdoc = buildSandboxDocument(token, encodeUtf8Base64(source), mode);
  };

  window.runPythonAutoSandbox = function(code) {
    const source = String(code || '');
    const importsTurtle = /^\s*(?:import\s+turtle\b|from\s+turtle\s+import\b)/m.test(source) || /\bTurtle\s*\(/.test(source);
    const importsPygame = /^\s*(?:import\s+pygame\b|from\s+pygame\s+import\b)/m.test(source);
    const importsPygameZero = /^\s*#!\s*pgzrun\b/m.test(source) || /^\s*(?:import\s+pgzrun\b|(?:import|from)\s+pgzero\b)/m.test(source);
    const importsPyodideOnly = /^\s*(?:import|from)\s+(?:numpy|pandas|scipy|sympy|sklearn|matplotlib|PIL|pygame|pgzero|pgzrun|pydantic|bs4)\b/m.test(source);

    if (source.length > MAX_CODE_LENGTH) {
      showNotice('Код слишком большой для запуска (лимит 200 КБ).');
      return;
    }
    if (importsTurtle && (importsPyodideOnly || importsPygameZero)) {
      showNotice('В этом проекте смешаны Turtle и библиотеки CPython или Pygame Zero. Turtle работает в совместимом Brython, а расширенные библиотеки и игры — в Pyodide. Эти движки пока нельзя смешивать в одном запуске. Старый Turtle-код не изменён.');
      return;
    }
    if (importsPygameZero) {
      window.runPythonPyodideSandbox(source, {mode:'pgzero'});
      return;
    }
    if (importsTurtle) {
      if (activeRunCleanup) activeRunCleanup(true);
      if (typeof window.runPythonSandbox === 'function') {
        window.runPythonSandbox(source);
      } else {
        showNotice('Совместимая среда Turtle не загрузилась. Обновите страницу.');
      }
      return;
    }
    if (importsPygame && /\bwhile\b/.test(source) && !/\bawait\s+(?:asyncio\.)?sleep\s*\(/.test(source)) {
      showNotice('Обнаружен игровой цикл Pygame без await asyncio.sleep(...). Синхронный бесконечный цикл может заморозить вкладку, поэтому StarAlgo остановил запуск заранее. Для браузерной игры нужен асинхронный цикл, который регулярно уступает управление браузеру.');
      return;
    }

    window.runPythonPyodideSandbox(source, {mode:importsPygame ? 'pygame' : 'python'});
  };

  window.stopPythonAutoSandbox = function() {
    if (typeof window.stopPythonPyodideSandbox === 'function') window.stopPythonPyodideSandbox();
    if (typeof window.stopPythonSandbox === 'function') window.stopPythonSandbox();
  };

  window.stopPythonPyodideSandbox = function() {
    if (activeRunCleanup) activeRunCleanup(true);
    const outputBox = document.getElementById('python-console-output');
    const canvasBox = document.getElementById('turtle-graphics-canvas-container');
    if (outputBox) {
      outputBox.textContent = 'Выполнение Python остановлено пользователем.';
      outputBox.style.color = '#ff5555';
    }
    if (canvasBox) {
      canvasBox.replaceChildren();
      const note = document.createElement('div');
      note.style.cssText = 'padding:12px;color:#333;font:13px monospace;';
      note.textContent = 'Выполнение остановлено.';
      canvasBox.appendChild(note);
    }
  };
})();
