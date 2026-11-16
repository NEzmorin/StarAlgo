(() => {
  'use strict';
  const VERSION = Object.freeze({
    react: '19.2.6', preact: '10.29.8', phaser: '3.90.0', three: '0.187.0',
    pixi: '8.23.0', matter: '0.20.0', clsx: '2.1.1',
    tailwindMerge: '3.4.0', esbuild: '0.25.9'
  });
  function detect(source) {
    const code = String(source || '');
    const has = (re) => re.test(code);
    return {
      react: has(/\bReactDOM\b|\bReact\b|(?:from|import)\s*['"][^'"]*react(?:\/[^'"]*)?['"]/),
      preact: has(/\bpreact(?:Hooks|Compat)?\b|(?:from|import)\s*['"]preact(?:\/[^'"]*)?['"]/),
      phaser: has(/\bPhaser\b|(?:from|import)\s*['"]phaser['"]/),
      three: has(/\bTHREE\b|(?:from|import)\s*['"]three(?:\/[^'"]*)?['"]/),
      pixi: has(/\bPIXI\b|(?:from|import)\s*['"]pixi\.js(?:\/[^'"]*)?['"]/),
      matter: has(/\bMatter\b|(?:from|import)\s*['"]matter-js['"]/),
      esbuild: has(/esbuild-wasm|esbuild\.wasm/),
      clsx: has(/(?:from|import)\s*['"]clsx['"]/),
      tailwindMerge: has(/(?:from|import)\s*['"]tailwind-merge['"]/)
    };
  }
  function rewriteKnownUrls(source, root) {
    let code = String(source || '');
    const base = root + '/api/runtime-libraries/';
    const rules = [
      [/https?:\/\/esm\.sh\/react(?:@[^\/'"\x60?\s]+)?\/jsx-runtime(?:\?[^'"\x60\s]*)?/gi, base + 'react/jsx-runtime.js'],
      [/https?:\/\/esm\.sh\/react(?:@[^\/'"\x60?\s]+)?\/jsx-dev-runtime(?:\?[^'"\x60\s]*)?/gi, base + 'react/jsx-runtime.js'],
      [/https?:\/\/esm\.sh\/react(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'react/index.js'],
      [/https?:\/\/esm\.sh\/react-dom(?:@[^\/'"\x60?\s]+)?\/client(?:\?[^'"\x60\s]*)?/gi, base + 'react-dom/client.js'],
      [/https?:\/\/esm\.sh\/react-dom(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'react-dom/index.js'],
      [/https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/umd-react@19\.2\.6\/dist\/react\.production\.min\.js/gi, base + 'react/react.production.min.js'],
      [/https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/umd-react@19\.2\.6\/dist\/react-dom\.production\.min\.js/gi, base + 'react/react-dom.production.min.js'],
      [/https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/react(?:@[^\/'"\x60?\s]+)?\/(?:umd\/)?react(?:\.production)?(?:\.min)?\.js/gi, base + 'react/react.production.min.js'],
      [/https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/react-dom(?:@[^\/'"\x60?\s]+)?\/(?:umd\/)?react-dom(?:\.production)?(?:\.min)?\.js/gi, base + 'react/react-dom.production.min.js'],
      [/https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/[^\/'"\x60?\s]+\/react(?:\.production)?(?:\.min)?\.js/gi, base + 'react/react.production.min.js'],
      [/https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/[^\/'"\x60?\s]+\/react-dom(?:\.production)?(?:\.min)?\.js/gi, base + 'react/react-dom.production.min.js'],
      [/https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/esbuild-wasm@0\.25\.9\/esm\/browser\.js/gi, base + 'esbuild-wasm/esm/browser.js'],
      [/https?:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/esbuild-wasm@0\.25\.9\/esbuild\.wasm/gi, base + 'esbuild-wasm/esbuild.wasm'],
      [/https?:\/\/esm\.sh\/esbuild-wasm(?:@0\.25\.9)?(?:\?[^'"\x60\s]*)?/gi, base + 'esbuild-wasm/esm/browser.js'],
      [/https?:\/\/esm\.sh\/three(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'three/build/three.module.js'],
      [/https?:\/\/esm\.sh\/preact(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'preact/dist/preact.mjs'],
      [/https?:\/\/esm\.sh\/phaser(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'phaser/index.js'],
      [/https?:\/\/esm\.sh\/pixi\.js(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'pixi/dist/pixi.min.mjs'],
      [/https?:\/\/esm\.sh\/matter-js(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'matter/index.js'],
      [/https?:\/\/esm\.sh\/clsx(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'clsx/dist/clsx.mjs'],
      [/https?:\/\/esm\.sh\/tailwind-merge(?:@[^\/'"\x60?\s]+)?(?:\?[^'"\x60\s]*)?/gi, base + 'tailwind-merge/dist/bundle-mjs.mjs']
    ];
    for (const [pattern, replacement] of rules) code = code.replace(pattern, replacement);
    return code;
  }
  function buildPrelude(source, apiRoot) {
    const root = String(apiRoot || '').replace(/\/+$/, '');
    if (!root || !/^https:\/\//i.test(root)) return {
      head: '', source: String(source || ''), libraries: [], error: 'API библиотек StarAlgo не настроен.'
    };
    const base = root + '/api/runtime-libraries/';
    const found = detect(source);
    const imports = {
      'react': base + 'react/index.js',
      'react/jsx-runtime': base + 'react/jsx-runtime.js',
      'react/jsx-dev-runtime': base + 'react/jsx-runtime.js',
      'react-dom': base + 'react-dom/index.js',
      'react-dom/client': base + 'react-dom/client.js',
      'preact': base + 'preact/dist/preact.mjs',
      'preact/hooks': base + 'preact/hooks/dist/hooks.mjs',
      'preact/compat': base + 'preact/compat/dist/compat.mjs',
      'preact/jsx-runtime': base + 'preact/jsx-runtime/dist/jsxRuntime.mjs',
      'phaser': base + 'phaser/index.js',
      'three': base + 'three/build/three.module.js',
      'three/addons/': base + 'three/examples/jsm/',
      'pixi.js': base + 'pixi/dist/pixi.min.mjs',
      'pixi.js/': base + 'pixi/',
      'matter-js': base + 'matter/index.js',
      'clsx': base + 'clsx/dist/clsx.mjs',
      'tailwind-merge': base + 'tailwind-merge/dist/bundle-mjs.mjs',
      'esbuild-wasm': base + 'esbuild-wasm/esm/browser.js'
    };
    const importMap = '<script type="importmap">' +
      JSON.stringify({ imports }).replace(/</g, '\\u003c') + '</script>';
    const scripts = [];
    const add = (path) => scripts.push('<script src="' + base + path + '" crossorigin="anonymous"></script>');
    if (found.react) {
      add('react/react.production.min.js');
      add('react/react-dom.production.min.js');
    }
    if (found.preact && /\bpreact(?:Hooks|Compat)?\b/.test(String(source || '')) &&
        !/(?:from|import)\s*['"]preact(?:\/[^'"]*)?['"]/.test(String(source || ''))) {
      add('preact/dist/preact.umd.js');
      add('preact/hooks/dist/hooks.umd.js');
      add('preact/compat/dist/compat.umd.js');
    }
    if (found.phaser) add('phaser/dist/phaser.min.js');
    if (found.pixi && /\bPIXI\b/.test(String(source || ''))) add('pixi/dist/pixi.min.js');
    if (found.matter) add('matter/build/matter.min.js');
    const libraries = Object.keys(found).filter(key => found[key]);
    return { head: importMap + scripts.join(''), source: rewriteKnownUrls(source, root), libraries, error: '' };
  }
  window.StarAlgoHtmlRuntime = Object.freeze({ VERSION, detect, buildPrelude });
})();