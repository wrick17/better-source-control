'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadIconTheme, fileIcon } = require('../file-icons');

test('uses installed theme associations, variants and bounded local icon assets with fallbacks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-icons-'));
  const outside = `${root}-outside.svg`;
  try {
    fs.writeFileSync(outside, '<svg>outside</svg>');
    for (const name of ['file', 'ts', 'test', 'named', 'folder', 'light', 'language']) {
      fs.writeFileSync(path.join(root, `${name}.svg`), `<svg>${name}</svg>`);
    }
    const data = {
      file: 'file', folderExpanded: 'folder', fileExtensions: { ts: 'ts', 'test.ts': 'test', 'special/ts': 'named' },
      fileNames: { 'special.ts': 'named' }, languageIds: { example: 'language' },
      light: { fileExtensions: { ts: 'light' } },
      iconDefinitions: Object.fromEntries(['file', 'ts', 'test', 'named', 'folder', 'light', 'language']
        .map((name) => [name, { iconPath: `${name}.svg` }])),
    };
    data.iconDefinitions.escape = { iconPath: `../${path.basename(outside)}` };
    data.fileNames['escape.ts'] = 'escape';
    fs.writeFileSync(path.join(root, 'large.svg'), Buffer.alloc(512 * 1024 + 1));
    data.iconDefinitions.large = { iconPath: 'large.svg' };
    data.fileNames['large.ts'] = 'large';
    fs.writeFileSync(path.join(root, 'theme.json'), JSON.stringify(data));
    const extensions = [{ extensionPath: root, packageJSON: { contributes: {
      iconThemes: [{ id: 'test', path: 'theme.json' }], languages: [{ id: 'example', extensions: ['.example'] }],
    } } }];
    const theme = loadIconTheme(extensions, 'test');
    const contents = (source) => Buffer.from(source.split(',')[1], 'base64').toString();
    assert.equal(contents(fileIcon(theme, 'src/foo.ts')), '<svg>ts</svg>');
    assert.equal(contents(fileIcon(theme, 'src/foo.test.ts')), '<svg>test</svg>');
    assert.equal(contents(fileIcon(theme, 'src/SPECIAL.TS')), '<svg>named</svg>');
    assert.equal(contents(fileIcon(theme, 'special/foo.test.ts')), '<svg>named</svg>');
    assert.equal(contents(fileIcon(theme, 'src/unknown')), '<svg>file</svg>');
    assert.equal(contents(fileIcon(theme, 'src/foo.example')), '<svg>language</svg>');
    assert.equal(contents(fileIcon(theme, 'src', true)), '<svg>folder</svg>');
    assert.equal(contents(fileIcon(loadIconTheme(extensions, 'test', 1), 'foo.ts')), '<svg>light</svg>');
    assert.equal(fileIcon(theme, 'escape.ts'), undefined);
    assert.equal(fileIcon(theme, 'large.ts'), undefined);
    assert.equal(fileIcon(undefined, 'foo.ts'), undefined);
    assert.equal(loadIconTheme(extensions, 'missing'), undefined);
    fs.rmSync(path.join(root, 'ts.svg'));
    assert.equal(contents(fileIcon(theme, 'foo.ts')), '<svg>ts</svg>');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
