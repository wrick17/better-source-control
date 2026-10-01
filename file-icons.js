'use strict';

const fs = require('node:fs');
const path = require('node:path');

function themeResource(root, filename) {
  const resolved = fs.realpathSync(filename);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Icon resource is outside its extension');
  }
  return resolved;
}

function loadIconTheme(extensions, id, colorKind = 2) {
  try {
    const extension = extensions.find((item) =>
      item.packageJSON.contributes?.iconThemes?.some((theme) => theme.id === id));
    if (!extension) return undefined;
    const entry = extension.packageJSON.contributes.iconThemes.find((theme) => theme.id === id);
    const root = fs.realpathSync(extension.extensionPath);
    const filename = themeResource(root, path.resolve(root, entry.path));
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const associations = { ...data };
    for (const variant of [colorKind === 1 || colorKind === 4 ? data.light : undefined,
      colorKind === 3 || colorKind === 4 ? data.highContrast : undefined]) {
      for (const [key, value] of Object.entries(variant ?? {})) {
        associations[key] = typeof value === 'object' ? { ...associations[key], ...value } : value;
      }
    }
    const languages = { names: {}, extensions: {} };
    for (const item of extensions) {
      for (const language of item.packageJSON.contributes?.languages ?? []) {
        for (const name of language.filenames ?? []) languages.names[name.toLowerCase()] = language.id;
        for (const suffix of language.extensions ?? []) languages.extensions[suffix.slice(1).toLowerCase()] = language.id;
      }
    }
    return { root, directory: path.dirname(filename), data, associations, languages, cache: new Map() };
  } catch {
    return undefined;
  }
}

function fileIcon(theme, relativePath, folder = false) {
  if (!theme) return undefined;
  const name = path.basename(relativePath).toLowerCase();
  const parent = path.basename(path.dirname(relativePath)).toLowerCase();
  const match = (mapping, key) => mapping?.[`${parent}/${key}`] ?? mapping?.[key];
  const associations = theme.associations;
  let id;
  if (folder) {
    id = match(associations.folderNamesExpanded, name) ?? match(associations.folderNames, name)
      ?? associations.folderExpanded ?? associations.folder;
  } else {
    const suffixes = name.split('.').slice(1).map((_, index, parts) => parts.slice(index).join('.'));
    id = match(associations.fileNames, name);
    // Parent-specific extension associations take precedence over plain extensions.
    id ??= suffixes.map((suffix) => associations.fileExtensions?.[`${parent}/${suffix}`]).find(Boolean);
    id ??= suffixes.map((suffix) => associations.fileExtensions?.[suffix]).find(Boolean);
    const language = theme.languages.names[name]
      ?? suffixes.map((suffix) => theme.languages.extensions[suffix]).find(Boolean);
    id ??= associations.languageIds?.[language] ?? associations.file;
  }
  if (theme.cache.has(id)) return theme.cache.get(id);
  let source;
  try {
    const definition = theme.data.iconDefinitions?.[id];
    // ponytail: image themes only; add glyph-font rendering when a font theme is needed.
    if (definition?.iconPath) {
      const filename = themeResource(theme.root, path.resolve(theme.directory, definition.iconPath));
      const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(filename).toLowerCase()];
      if (mime && fs.statSync(filename).size <= 512 * 1024) {
        source = `data:${mime};base64,${fs.readFileSync(filename).toString('base64')}`;
      }
    }
  } catch { /* Missing or unsupported theme assets use the generic icon. */ }
  theme.cache.set(id, source);
  return source;
}

module.exports = { loadIconTheme, fileIcon };
