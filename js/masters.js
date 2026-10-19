// ============================================================
// masters.js — 原料マスターの取得・正規化・分類フィルタ。
// 優先順位：①ローカルキャッシュ（前回取得成功分）→②ライブ取得（doGet action=read）
//   →③同梱フォールバック（masters_seed.js）。
// 依存：storage.js, masters_seed.js
// ============================================================
window.App = window.App || {};

App.Masters = (function () {
  'use strict';

  const SHEET_NAME = '原料マスター';
  // 実シートの列名（2026-07-31 本番doGetで実測・確定）：
  //   原料ID / 原料名 / メーカー名 / 原料分類 / デフォルト単位 / 発注点（任意） / 備考 / EBC / IBU
  // ⚠ 先頭が実列名。以降は表記ゆれの保険であって推測の主役ではない。
  //   2026-07-31まで CATEGORY_KEYS に実列名『原料分類』が無く、ライブ取得時は全品が
  //   「分類なし」に落ちて区分で全く絞れていなかった（全区分に全47件が出る状態）→ B-081。
  const NAME_KEYS = ['原料名', '名称', '品名', 'name'];
  const CATEGORY_KEYS = ['原料分類', '分類', '区分', '種別', 'カテゴリ', 'category'];
  const KNOWN_CATEGORIES = ['麦芽', 'ホップ', '酵母', 'その他の原料', 'その他'];
  // Ponkichi「原料マスター」の実分類（5種）→ 入荷ペイロードの区分（4種）への対応。
  // ⚠ 出典＝本番Ponkichiの実データ（2026-07-31確認）。推定で足さないこと。
  // 「麦・米・糖類」（Flaked Oats・そば米・酒粕・蕎麦の実・乳糖・氷砂糖）が抜けていたため、
  // ライブ取得時にこの6品が全区分から消えていた（2026-07-31修正・B-081）。
  const SHEET_CATEGORY_MAP = {
    '麦芽': '麦芽',
    'ホップ': 'ホップ',
    '酵母': '酵母',
    '麦・米・糖類': 'その他の原料',
    'その他': 'その他の原料',
  };

  function pickKey(row, candidates) {
    for (const k of candidates) {
      if (Object.prototype.hasOwnProperty.call(row, k) && String(row[k]).trim() !== '') {
        return row[k];
      }
    }
    return null;
  }

  function normalizeCategory(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    // ① 実シートの分類名との対応表を最優先（正本＝Ponkichiの実データ）
    if (Object.prototype.hasOwnProperty.call(SHEET_CATEGORY_MAP, s)) {
      return SHEET_CATEGORY_MAP[s];
    }
    if (KNOWN_CATEGORIES.indexOf(s) !== -1) {
      return s === 'その他' ? 'その他の原料' : s;
    }
    // 部分一致（表記ゆれ吸収の最小限）
    if (s.indexOf('麦芽') !== -1) return '麦芽';
    if (s.indexOf('ホップ') !== -1) return 'ホップ';
    if (s.indexOf('酵母') !== -1) return '酵母';
    return null; // 未知の表記は「分類なし」扱い（誤分類より安全）
  }

  function normalizeRows(rows) {
    const items = [];
    for (const row of rows) {
      const name = pickKey(row, NAME_KEYS);
      if (!name) continue;
      const catRaw = pickKey(row, CATEGORY_KEYS);
      items.push({ name: String(name).trim(), category: normalizeCategory(catRaw) });
    }
    return items;
  }

  // ── ライブ取得 ──
  async function fetchLive(bridgeUrl, sheetName) {
    if (!bridgeUrl) throw new Error('送信先URL未設定');
    const sheet = sheetName || SHEET_NAME;
    const url = bridgeUrl.replace(/\/$/, '') + '?action=read&sheet=' + encodeURIComponent(sheet);
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.success !== true) {
      throw new Error((json && json.error) || '取得失敗（原因不明）');
    }
    return { header: json.header || [], rows: json.rows || [] };
  }

  // 起動時・設定画面から呼ぶ。成功したらキャッシュを更新して返す。失敗時は例外を投げる（呼び出し側でフォールバック判断）。
  async function refresh(bridgeUrl) {
    const { header, rows } = await fetchLive(bridgeUrl, SHEET_NAME);
    const normalized = normalizeRows(rows);
    const cache = {
      fetchedAt: new Date().toISOString(),
      source: 'live',
      sheet: SHEET_NAME,
      header,
      items: normalized,
    };
    App.Storage.setMasters(cache);
    return cache;
  }

  // ── 製品マスターのライブ取得（B-083②）──
  // 目的：製品名の正を**Ponkichiの製品マスター1か所**に固定し、入力経路ごとの表記ゆれを構造的に断つ。
  // 背景：2026-07-31、仕込み/発酵管理は手入力・製品化はマスターのプルダウンという経路差で
  //   同一バッチ#12が `Trail Head` と `Trailhead` に割れていた（task.md B-072）。
  // 実列名（2026-07-31 doGetで実測）：製品ID / 製品名 / 販売価格（税抜）
  const PRODUCT_SHEET_NAME = '製品マスター';
  const PRODUCT_NAME_KEYS = ['製品名', '発泡酒名', '品名', 'name'];

  function normalizeProductRows(rows) {
    const names = [];
    for (const row of rows) {
      const name = pickKey(row, PRODUCT_NAME_KEYS);
      if (!name) continue;
      // ⚠ trim のみ。大文字小文字・スペースは**一切いじらない**（`PON IPA`が正＝マスターの綴りが正本）
      names.push(String(name).trim());
    }
    return names;
  }

  async function refreshProducts(bridgeUrl) {
    const { header, rows } = await fetchLive(bridgeUrl, PRODUCT_SHEET_NAME);
    const items = normalizeProductRows(rows);
    if (items.length === 0) {
      // 空のマスターでキャッシュを上書きすると選択肢が消える。取得失敗と同じ扱いにする。
      throw new Error('製品マスターに製品名が1件もありません');
    }
    const cache = {
      fetchedAt: new Date().toISOString(),
      source: 'live',
      sheet: PRODUCT_SHEET_NAME,
      header,
      items,
    };
    App.Storage.setProductMasters(cache);
    return cache;
  }

  function getActiveProducts() {
    const cached = App.Storage.getProductMasters();
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      return cached;
    }
    return {
      fetchedAt: null,
      source: 'seed',
      sheet: PRODUCT_SHEET_NAME,
      header: [],
      items: App.MastersSeed.products,
    };
  }

  // 現在使うべきマスターを返す（キャッシュ優先。無ければ同梱フォールバック）。
  function getActive() {
    const cached = App.Storage.getMasters();
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      return cached;
    }
    return {
      fetchedAt: null,
      source: 'seed',
      sheet: SHEET_NAME,
      header: [],
      items: App.MastersSeed.items,
    };
  }

  // 区分（麦芽／ホップ／酵母／その他の原料）で絞り込んだ原料名リストを返す。
  // マスターに分類情報が一切無い（全件category:null）場合は、区分では絞らず全件を返す
  // （実シートに分類列が無いケースへの安全なデグレード）。
  function getIngredientNames(kubun) {
    const active = getActive();
    const items = active.items || [];
    const hasAnyCategory = items.some(function (it) { return it.category; });
    let filtered;
    if (!hasAnyCategory) {
      filtered = items;
    } else {
      filtered = items.filter(function (it) { return it.category === kubun; });
    }
    // 重複除去・五十音/アルファベット順
    const names = Array.from(new Set(filtered.map(function (it) { return it.name; })));
    names.sort(function (a, b) { return a.localeCompare(b, 'ja'); });
    return names;
  }

  // ── 仕入先・メーカーの候補 ──
  // 同梱の初期候補（暫定）＋ 過去に実際に入力した値 の和集合。使うほど候補が育つ。
  // ⚠ 将来：取引先マスター／原料マスターのメーカー名列を読めるようになったら、そちらを正にする。
  function unionSorted(a, b) {
    const all = [].concat(a || [], b || []).filter(function (s) { return s && String(s).trim() !== ''; });
    const uniq = Array.from(new Set(all.map(function (s) { return String(s).trim(); })));
    uniq.sort(function (x, y) { return x.localeCompare(y, 'ja'); });
    return uniq;
  }

  function getSupplierCandidates() {
    return unionSorted(App.MastersSeed.suppliers, App.Storage.getSupplierCandidates());
  }

  function getMakerCandidates() {
    return unionSorted(App.MastersSeed.makers, App.Storage.getMakerCandidates());
  }

  // ── 製品名の候補（P3詰口用）──
  // ライブ取得できていれば**製品マスターの内容だけ**を返す（seedと和集合にしない）。
  // ⚠ 和集合にすると、マスターから消した／直した綴りが同梱seed経由で候補に復活し、
  //   表記ゆれ対策そのものが無効になる。ここは意図的に「マスターが正、seedは非常用」。
  function getProductCandidates() {
    const active = getActiveProducts();
    const names = Array.from(new Set((active.items || []).filter(function (s) {
      return s && String(s).trim() !== '';
    })));
    names.sort(function (a, b) { return a.localeCompare(b, 'ja'); });
    return names;
  }

  // ── 容器マスターのライブ取得（2026-10-19）──
  // ⚠ 容器名はGASが容器マスターから「容量(L)」を引くキー。1字違えば容量0＝総量(L)0で着地する。
  //   そのため製品マスターと同じ「マスターが正・seedは非常用」方式にし、和集合にはしない。
  const CONTAINER_SHEET_NAME = '容器マスター';
  const CONTAINER_NAME_KEYS = ['容器名', '容器', 'name'];

  async function refreshContainers(bridgeUrl) {
    const { header, rows } = await fetchLive(bridgeUrl, CONTAINER_SHEET_NAME);
    const items = [];
    for (const row of rows) {
      const name = pickKey(row, CONTAINER_NAME_KEYS);
      if (!name) continue;
      items.push(String(name).trim()); // ⚠ trimのみ。全角括弧・ℓ・大小文字は一切いじらない
    }
    if (items.length === 0) throw new Error('容器マスターに容器名が1件もありません');
    const cache = {
      fetchedAt: new Date().toISOString(), source: 'live',
      sheet: CONTAINER_SHEET_NAME, header: header, items: items,
    };
    App.Storage.setContainerMasters(cache);
    return cache;
  }

  function getActiveContainers() {
    const cached = App.Storage.getContainerMasters();
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) return cached;
    return { fetchedAt: null, source: 'seed', sheet: CONTAINER_SHEET_NAME, header: [],
             items: App.MastersSeed.containers };
  }

  // ── 容器の候補（P3詰口用）──
  // ライブ取得できていればマスターの内容だけを返す（seedと和集合にしない＝綴り違いを復活させない）。
  function getContainerCandidates() {
    const active = getActiveContainers();
    return (active.items || []).filter(function (s) { return s && String(s).trim() !== ''; });
  }

  // ── 取引先マスターのライブ取得（P4出荷用・2026-10-19）──
  // 実列名（2026-10-19 doGetで実測）：取引先ID / 取引先名 / 区分 / 電話番号 / 担当者名 / 備考
  //   区分は「仕入先」または「出荷先」。出荷先は4件（直販・剣山観光センター・脇町蔵置所・寄贈）。
  const PARTNER_SHEET_NAME = '取引先マスター';

  async function refreshPartners(bridgeUrl) {
    const { header, rows } = await fetchLive(bridgeUrl, PARTNER_SHEET_NAME);
    const shipTo = [], suppliers = [];
    for (const row of rows) {
      const name = String(pickKey(row, ['取引先名', '名称', 'name']) || '').trim();
      if (!name) continue;
      const kubun = String(row['区分'] || '').trim();
      if (kubun.indexOf('出荷') !== -1) shipTo.push(name);
      else if (kubun.indexOf('仕入') !== -1) suppliers.push(name);
    }
    if (shipTo.length === 0) throw new Error('取引先マスターに「出荷先」が1件もありません');
    const cache = {
      fetchedAt: new Date().toISOString(), source: 'live',
      sheet: PARTNER_SHEET_NAME, header: header, shipTo: shipTo, suppliers: suppliers,
    };
    App.Storage.setPartnerMasters(cache);
    return cache;
  }

  function getActivePartners() {
    const cached = App.Storage.getPartnerMasters();
    if (cached && Array.isArray(cached.shipTo) && cached.shipTo.length > 0) return cached;
    return { fetchedAt: null, source: 'seed', sheet: PARTNER_SHEET_NAME,
             shipTo: App.MastersSeed.shipTo, suppliers: [] };
  }

  // 出荷先の候補＝取引先マスター（区分=出荷先）。過去入力とは和集合にしない（正はマスター）。
  function getShipToCandidates() {
    return (getActivePartners().shipTo || []).slice();
  }

  // ── 製品在庫スナップショット（P4出荷用・2026-10-19）──
  // 目的：出荷画面の「出荷製品・バッチ」は**在庫がある組み合わせだけ**を出す。
  //   processShukka は "製品名 (容器) (#バッチNo)" という1本の文字列を正規表現で分解するため、
  //   アプリ側が同じ形の文字列を組み立てる。素は製品受払簿そのもの（受入(製造) − 払出(出荷)）。
  // 検証（2026-10-19）：自前集計の6組 7/72/284/528/1115/926 が、シート自身の
  //   「バッチ在庫」列の値と完全一致。GAS側の2段正規表現での往復もnodeで全件通過。
  const SEIHIN_SHEET_NAME = '製品受払簿';

  function stockLabel(product, batch, container) {
    return product + ' (' + container + ') (' + batch + ')';
  }

  async function refreshStock(bridgeUrl) {
    const { rows } = await fetchLive(bridgeUrl, SEIHIN_SHEET_NAME);
    const order = [];
    const map = {};
    const kubunCount = {}; // 取引先 → { 区分: 件数 }（既定値の推定用）
    for (const row of rows) {
      const kubunTorihiki = String(row['取引区分'] || '').trim();
      if (!kubunTorihiki) continue;
      const product = String(row['製品名'] || '').trim();
      const batch = String(row['バッチNo'] || '').trim();
      const container = String(row['容器'] || '').trim();
      let qty = Number(row['数量（個数）']);
      if (!isFinite(qty)) qty = 0;
      if (product && batch) {
        const key = product + '\u0000' + batch + '\u0000' + container;
        if (!Object.prototype.hasOwnProperty.call(map, key)) {
          map[key] = { product: product, batch: batch, container: container, qty: 0 };
          order.push(key);
        }
        // 受入(製造)＝プラス／払出(出荷)＝マイナス
        map[key].qty += (kubunTorihiki.indexOf('受入') === 0) ? qty : -qty;
      }
      if (kubunTorihiki.indexOf('払出') === 0) {
        const partner = String(row['取引先'] || '').trim();
        const sk = String(row['出荷先区分'] || '').trim();
        if (partner && sk) {
          if (!kubunCount[partner]) kubunCount[partner] = {};
          kubunCount[partner][sk] = (kubunCount[partner][sk] || 0) + 1;
        }
      }
    }
    // 取引先ごとに「いちばん多く使われている出荷先区分」を既定値にする（履歴から自動で育つ）
    const kubunByPartner = {};
    Object.keys(kubunCount).forEach(function (p) {
      let best = null, bestN = -1;
      Object.keys(kubunCount[p]).forEach(function (k) {
        if (kubunCount[p][k] > bestN) { best = k; bestN = kubunCount[p][k]; }
      });
      if (best) kubunByPartner[p] = best;
    });

    const items = order.map(function (k) { return map[k]; })
      .filter(function (it) { return it.qty > 0; })
      .map(function (it) {
        it.label = stockLabel(it.product, it.batch, it.container);
        return it;
      });
    // ⚠ items が0件でも成功扱いにする（在庫が本当に全部出払っている状態は正常）。
    const cache = {
      fetchedAt: new Date().toISOString(), source: 'live',
      sheet: SEIHIN_SHEET_NAME, items: items, kubunByPartner: kubunByPartner,
    };
    App.Storage.setStock(cache);
    return cache;
  }

  function getActiveStock() {
    const cached = App.Storage.getStock();
    if (cached && Array.isArray(cached.items)) return cached;
    return { fetchedAt: null, source: 'none', sheet: SEIHIN_SHEET_NAME, items: [], kubunByPartner: {} };
  }

  return {
    refresh,
    refreshProducts,
    refreshContainers,
    refreshPartners,
    refreshStock,
    getActive,
    getActiveProducts,
    getActiveContainers,
    getActivePartners,
    getActiveStock,
    getIngredientNames,
    getSupplierCandidates,
    getMakerCandidates,
    getProductCandidates,
    getContainerCandidates,
    getShipToCandidates,
    stockLabel,
  };
})();
