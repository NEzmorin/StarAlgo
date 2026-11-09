/* StarAlgo isolated Pyodide preview.
 * Deliberately separate from the cloud/auth bridge.
 * Runtime: Pyodide 314.0.7 (CPython 3.14), loaded only when requested.
 */
(() => {
  'use strict';

  const PYODIDE_VERSION = '314.0.7';
  const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v' + PYODIDE_VERSION + '/full/';
  const OUTPUT_LIMIT = 50000;
  const RUN_TIMEOUT_MS = 90000;
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

  function buildSandboxDocument(token, encodedCode) {
    const policy = [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
      'connect-src https://cdn.jsdelivr.net',
      "style-src 'unsafe-inline'",
      'img-src data: blob:',
      'font-src data:',
      'media-src data: blob:',
      "worker-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ');

    return [
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
      '<meta name="referrer" content="no-referrer">',
      '<meta http-equiv="Content-Security-Policy" content="' + policy + '">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<style>html,body{margin:0;min-height:100%;font:14px monospace;background:#fff;color:#222}body{padding:12px;box-sizing:border-box}#status{color:#765f16}small{color:#666}</style>',
      '<script src="' + PYODIDE_BASE + 'pyodide.js"><' + '/script>',
      '</head><body><div id="status">Загрузка изолированной среды Pyodide…</div>',
      '<small>StarAlgo · CPython через WebAssembly</small>',
      '<script>',
      '(async function(){',
      '  const TOKEN = ' + JSON.stringify(token) + ';',
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
      '    status.textContent = "Python готов. Проверяю импорты и загружаю нужные пакеты…";',
      '    send("status", {message:"Pyodide готов. Проверка импортов и загрузка используемых пакетов…"});',
      '    await pyodide.loadPackagesFromImports(source);',
      '    send("status", {message:"Пакеты готовы. Выполняю программу…"});',
      '    const result = await pyodide.runPythonAsync(source);',
      '    if (result && typeof result.destroy === "function") result.destroy();',
      '    const version = pyodide.runPython("import sys; sys.version");',
      '    if (truncated) output += "\\n[Вывод обрезан: достигнут лимит 50 000 символов.]";',
      '    send("done", {ok:true, output:output, pythonVersion:String(version)});',
      '  } catch (error) {',
      '    append((output ? "\\n" : "") + String(error && (error.stack || error.message) || error));',
      '    if (truncated) output += "\\n[Вывод обрезан: достигнут лимит 50 000 символов.]";',
      '    send("done", {ok:false, output:output || "Ошибка запуска Pyodide."});',
      '  }',
      '})();',
      '<' + '/script></body></html>'
    ].join('');
  }

  window.runPythonPyodideSandbox = function(code) {
    const canvasBox = document.getElementById('turtle-graphics-canvas-container');
    const outputBox = document.getElementById('python-console-output');
    const source = String(code || '');

    if (!canvasBox || !outputBox) return;
    if (source.length > 200000) {
      outputBox.textContent = 'Код слишком большой для запуска (лимит 200 КБ).';
      outputBox.style.color = '#ff5555';
      return;
    }

    if (activeRunCleanup) activeRunCleanup(true);
    if (typeof window.stopPythonSandbox === 'function') window.stopPythonSandbox();

    canvasBox.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.title = 'Изолированная среда Pyodide';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'display:block;width:100%;height:100%;min-height:280px;border:0;background:#fff;';
    canvasBox.appendChild(frame);

    const token = createToken();
    let timeoutId = 0;
    let observer = null;
    let finished = false;

    const cleanup = (removeFrame) => {
      if (finished) return;
      finished = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      if (observer) observer.disconnect();
      if (removeFrame && frame.parentNode) frame.remove();
      if (activeRunCleanup === cleanup) activeRunCleanup = null;
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
        cleanup(true);
        canvasBox.innerHTML = '<div style="color:#333;padding:12px;text-align:center;font:13px monospace;">Pyodide ' + PYODIDE_VERSION + ' · выполнение завершено. Вывод программы — ниже.</div>';
      }
    };

    activeRunCleanup = cleanup;
    window.addEventListener('message', onMessage);
    observer = new MutationObserver(() => {
      if (!frame.isConnected) cleanup(false);
    });
    observer.observe(canvasBox, {childList:true});

    timeoutId = window.setTimeout(() => {
      outputBox.textContent = 'Pyodide остановлен по тайм-ауту (90 секунд). Возможно, устройство не успело загрузить среду или программа зациклилась.';
      outputBox.style.color = '#ff5555';
      cleanup(true);
      canvasBox.innerHTML = '<div style="color:#333;padding:12px;text-align:center;font:13px monospace;">Выполнение Pyodide остановлено по тайм-ауту.</div>';
    }, RUN_TIMEOUT_MS);

    outputBox.textContent = 'Загрузка Pyodide ' + PYODIDE_VERSION + '… Первый запуск может занять больше времени.';
    outputBox.style.color = '#d4b236';
    frame.srcdoc = buildSandboxDocument(token, encodeUtf8Base64(source));
  };

  window.stopPythonPyodideSandbox = function() {
    if (activeRunCleanup) activeRunCleanup(true);
    const outputBox = document.getElementById('python-console-output');
    const canvasBox = document.getElementById('turtle-graphics-canvas-container');
    if (outputBox) {
      outputBox.textContent = 'Выполнение Pyodide остановлено пользователем.';
      outputBox.style.color = '#ff5555';
    }
    if (canvasBox) canvasBox.innerHTML = '<div style="color:#333;padding:12px;text-align:center;font:13px monospace;">Pyodide остановлен.</div>';
  };
})();