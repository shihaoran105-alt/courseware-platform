/**
 * 项目组：把项目按课程/科目归到一起。
 *
 *   EIE3333            ← 项目组
 *     ├── Lecture 1    ← 项目
 *     ├── Tut 1        ← 项目
 *     └── Lab 1        ← 项目
 *
 * 每个「小项目」自己保存上传的文件、分析结果、做题记录、Lab 进度、对话，
 * 所以切项目就等于切回那一次生成好的全部内容。
 *
 * 组信息存在 data/groups.json —— 刻意放在 cache/ 之外：
 * cache/ 目录下每个 .json 都会被 store.loadAll() 当成一个项目去加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const FILE = path.join(DATA_DIR, 'groups.json');

/** @type {{groups: Array}|null} */
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = { groups: Array.isArray(raw?.groups) ? raw.groups : [] };
  } catch {
    cache = { groups: [] };
  }
  return cache;
}

function save() {
  fs.writeFileSync(FILE, JSON.stringify(load(), null, 2), 'utf8');
}

const newId = (p = 'g') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 组名去空白 + 限长，避免把空名或超长名存进去 */
function cleanName(name = '') {
  return String(name).trim().slice(0, 60);
}

/** 某个会话能看到的组（公开模式下按 owner 隔离；本机模式 owner 为空则共用） */
export function listGroups(owner = '') {
  const { groups } = load();
  return groups
    .filter((g) => (g.owner || '') === (owner || ''))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt, updatedAt: g.updatedAt }));
}

export function getGroup(id) {
  return load().groups.find((g) => g.id === id) || null;
}

/** 能不能改这个组 */
export function canEditGroup(group, owner = '') {
  return Boolean(group) && (group.owner || '') === (owner || '');
}

export function createGroup(name, owner = '') {
  const g = {
    id: newId(),
    name: cleanName(name) || '新建项目组',
    owner: owner || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  load().groups.push(g);
  save();
  return g;
}

export function renameGroup(id, name, owner = '') {
  const g = getGroup(id);
  if (!g || !canEditGroup(g, owner)) return null;
  const next = cleanName(name);
  if (next) g.name = next;
  g.updatedAt = new Date().toISOString();
  save();
  return g;
}

/**
 * 删组不删项目 —— 项目会被退回「未分组」。
 * 直接连带删掉用户辛苦生成的分析结果太危险了。
 */
export function deleteGroup(id, owner = '') {
  const g = getGroup(id);
  if (!g || !canEditGroup(g, owner)) return null;
  const { groups } = load();
  const i = groups.findIndex((x) => x.id === id);
  if (i >= 0) groups.splice(i, 1);
  save();
  return g;
}

/** 组的存在性校验（项目设置 groupId 时用，防止挂到不存在的组上） */
export function groupExists(id, owner = '') {
  if (!id) return true; // 空 = 未分组，永远合法
  const g = getGroup(id);
  return Boolean(g) && canEditGroup(g, owner);
}
