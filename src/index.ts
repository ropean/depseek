/**
 * depseek — programmatic API. The `depseek` CLI is built on top of these functions.
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
export { buildSelection, selectEntries, parseKinds, parseLevels } from './select.js';
export type { Selection } from './select.js';
export { RegistryClient, loadRegistryConfig, changelogUrl, repoUrl, DEFAULT_REGISTRY } from './registry.js';
export type { PackageMeta, VersionMeta, RegistryConfig } from './registry.js';
export { analyze, BUILTIN_GROUPS } from './analyze.js';
export type { Analysis, AnalyzeOptions, Update, Warning, WarningType, Skipped, VulnerableUse } from './analyze.js';
export { pickTarget, diffLevel, candidates, LEVELS, TARGETS } from './versions.js';
export type { Level, LevelInfo, CandidateOptions } from './versions.js';
export { findConflicts, findPeerProblems, alignTarget, majorKey } from './conflicts.js';
export type { Conflict, ConflictType, Severity, Variant, PeerProblem, AlignStrategy } from './conflicts.js';
export { audit } from './audit.js';
export type { Vulnerability } from './audit.js';
export { planFileChanges, unifiedDiff, writeWithBackup, undo, listBackups } from './write.js';
export type { Change, FileChange, BackupManifest } from './write.js';
export { loadConfig, CONFIG_TEMPLATE } from './config.js';
export type { Config } from './config.js';
