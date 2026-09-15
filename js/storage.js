// ============================================================
// storage.js — localStorage の薄いラッパー。
// 送信先URL・マスターキャッシュ・キュー・履歴・前回値をすべてここに集約する。
// 依存なし。file:// でも動く純粋関数群。
// ============================================================
window.App = window.App || {};

App.Storage = (function () {
  'use strict';

  const KEYS = {
    BRIDGE_URL: 'ponkichi_bridge_url',
    MASTERS: 'ponkichi_masters_cache',   // 原料マスター { fetchedAt, source, sheet, header, items }
    PRODUCT_MASTERS: 'ponkichi_product_masters_cache', // 製品マスター { fetchedAt, source, sheet, header, items }
    QUEUE: 'ponkichi_queue',             // [{ uuid, event_type, fields, createdAt, attempts, lastError, lastAttemptAt }]
    HISTORY: 'ponkichi_history',         // 直近20件 [{ uuid, event_type, summary, status, sentAt }]
    LAST_RECORDER: 'ponkichi_last_recorder',
    LAST_SUPPLIER: 'ponkichi_last_supplier',
    LAST_MAKER: 'ponkichi_last_maker',
    SUPPLIER_CANDIDATES: 'ponkichi_supplier_candidates', // 過去に入力した仕入先（自由入力＋候補用）
    MAKER_CANDIDATES: 'ponkichi_maker_candidates',       // 過去に入力したメーカー（自由入力＋候補用）
  };

  function getRaw(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      console.error('[storage] getItem失敗', key, err);
      return null;
    }
  }

  function setRaw(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      // 容量超過・プライベートモード等。ユーザーに見える形で失敗を伝える必要がある呼び出し側で拾う。
      console.error('[storage] setItem失敗', key, err);
      return false;
    }
  }

  function getJSON(key, fallback) {
    const raw = getRaw(key);
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.error('[storage] JSON.parse失敗（壊れたデータを無視）', key, err);
      return fallback;
    }
  }

  function setJSON(key, obj) {
    return setRaw(key, JSON.stringify(obj));
  }

  // ── ブリッジURL ──
  function getBridgeUrl() {
    const v = getRaw(KEYS.BRIDGE_URL);
    return v ? v.trim() : '';
  }
  function setBridgeUrl(url) {
    return setRaw(KEYS.BRIDGE_URL, String(url).trim());
  }
  function clearBridgeUrl() {
    try { window.localStorage.removeItem(KEYS.BRIDGE_URL); } catch (err) { /* noop */ }
  }

  // ── マスターキャッシュ ──
  function getMasters() {
    return getJSON(KEYS.MASTERS, null);
  }
  function setMasters(obj) {
    return setJSON(KEYS.MASTERS, obj);
  }
  // 製品マスターは原料マスターと別枠で持つ（片方の取得が失敗しても他方を巻き添えにしない）
  function getProductMasters() {
    return getJSON(KEYS.PRODUCT_MASTERS, null);
  }
  function setProductMasters(obj) {
    return setJSON(KEYS.PRODUCT_MASTERS, obj);
  }

  // ── キュー ──
  function getQueue() {
    return getJSON(KEYS.QUEUE, []);
  }
  function setQueue(list) {
    return setJSON(KEYS.QUEUE, list);
  }

  // ── 履歴（直近20件） ──
  function getHistory() {
    return getJSON(KEYS.HISTORY, []);
  }
  function pushHistory(entry) {
    const list = getHistory();
    list.unshift(entry);
    while (list.length > 20) list.pop();
    setJSON(KEYS.HISTORY, list);
  }

  // ── 前回値（記録者・仕入先の1タップ確定用） ──
  function getLastRecorder() {
    return getRaw(KEYS.LAST_RECORDER) || '';
  }
  function setLastRecorder(name) {
    if (name) setRaw(KEYS.LAST_RECORDER, name);
  }
  function getLastSupplier() {
    return getRaw(KEYS.LAST_SUPPLIER) || '';
  }
  function setLastSupplier(name) {
    if (name) setRaw(KEYS.LAST_SUPPLIER, name);
  }
  function getLastMaker() {
    return getRaw(KEYS.LAST_MAKER) || '';
  }
  function setLastMaker(name) {
    if (name) setRaw(KEYS.LAST_MAKER, name);
  }

  // ── 候補リスト（仕入先／メーカー。マスターではなく「過去入力の重複除去リスト」＝候補表示＋自由入力用） ──
  function addCandidate(key, value) {
    const v = String(value || '').trim();
    if (!v) return;
    const list = getJSON(key, []);
    const without = list.filter(function (x) { return x !== v; });
    without.unshift(v);
    while (without.length > 30) without.pop();
    setJSON(key, without);
  }
  function getSupplierCandidates() {
    return getJSON(KEYS.SUPPLIER_CANDIDATES, []);
  }
  function addSupplierCandidate(value) {
    addCandidate(KEYS.SUPPLIER_CANDIDATES, value);
  }
  function getMakerCandidates() {
    return getJSON(KEYS.MAKER_CANDIDATES, []);
  }
  function addMakerCandidate(value) {
    addCandidate(KEYS.MAKER_CANDIDATES, value);
  }

  return {
    KEYS,
    getBridgeUrl, setBridgeUrl, clearBridgeUrl,
    getMasters, setMasters,
    getProductMasters, setProductMasters,
    getQueue, setQueue,
    getHistory, pushHistory,
    getLastRecorder, setLastRecorder,
    getLastSupplier, setLastSupplier,
    getLastMaker, setLastMaker,
    getSupplierCandidates, addSupplierCandidate,
    getMakerCandidates, addMakerCandidate,
  };
})();
