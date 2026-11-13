/**
 * depseek — programmatic API. The CLI (`depseek`) is built on top of these functions.
 */
export { scan, DEFAULT_IGNORE, linkWorkspaces } from './scan.js';
export type { ScanOptions, ScanResult, BrokenFile } from './scan.js';
export { renderTree } from './tree.js';
export type { TreeOptions } from './tree.js';
export { parseSpec, formatSpec, detectFormat, FORMATS } from './spec.js';
export type { ParsedSpec, SpecKind, Format } from './spec.js';
export { applyStringEdits, indexStrings } from './jsonEdit.js';
export type { StringEdit } from './jsonEdit.js';
export type { Project, DepEntry, DepKind, LockInfo, PackageManager } from './project.js';
