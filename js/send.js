// ============================================================
// send.js — 入荷ペイロード組み立て・キュー投入・送信・自動再送。
// 依存：storage.js
// 要件定義書§4・§6／jobs/ponkichi_schema.md §A-1 を実装。
// ============================================================
window.App = window.App || {};

App.Send = (function () {
  'use strict';

  // ============================================================
  // 備考欄の禁止パターン（B-064・§4-3）
  //   出典：jobs/brewlog_to_payload.py の FORBIDDEN_BIKO_PATTERNS と完全一致させる。
  //   GAS側はサーバーバリデーションをしないため、入力時点の警告が唯一の歯止め。
  //   エラーではなく警告（誤検知の余地があるため機械的には拒否しない）。
  // ============================================================
  const FORBIDDEN_BIKO_PATTERNS = [
    { re: /推定/, label: '不確実性を示す語『推定』' },
    { re: /見込み/, label: '不確実性を示す語『見込み』' },
    { re: /概算/, label: '不確実性を示す語『概算』' },
    { re: /合算/, label: '内部処理・按分の説明『合算』' },
    { re: /按分/, label: '内部処理・按分の説明『按分』' },
    { re: /§\s*\d/, label: '法令・章番号の参照（例：§4-1）' },
    { re: /届出/, label: '届出要否の記載（「届け出」列が正式な置き場）' },
    { re: /訂正/, label: '訂正経緯の記載『訂正』' },
    { re: /誤記/, label: '訂正経緯の記載『誤記』' },
    { re: /brewlog/i, label: 'brewlog参照・内部識別子' },
    { re: /brew_log/i, label: 'brewlog参照・内部識別子' },
    { re: /新居さん.{0,6}確定/, label: '意思決定の経緯（「新居さん確定」等）' },
  ];

  // 備考欄の値に §4-3 禁止パターンが含まれていないかチェックし、該当理由のラベル配列を返す。
  function checkBikoForbidden(value) {
    const s = String(value || '');
    const hits = [];
    FORBIDDEN_BIKO_PATTERNS.forEach(function (p) {
      if (p.re.test(s)) hits.push(p.label);
    });
    return hits;
  }

  const KUBUN_TO_FIELD = {
    '麦芽': '入荷した麦芽',
    'ホップ': '入荷したホップ',
    '酵母': '入荷した酵母',
    'その他の原料': '入荷した原料',
  };

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // フォールバック（file://・古いWebView対策）
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // 入力日付 (yyyy-mm-dd, <input type=date> 由来) → Ponkichi実フォーム表記 (yyyy/mm/dd) へ変換。
  // 出典：jobs/samples の実ペイロード例（"仕込日": "2026/06/01"）に合わせる。
  function toFormDate(isoDateStr) {
    if (!isoDateStr) return '';
    const parts = String(isoDateStr).split('-');
    if (parts.length !== 3) return isoDateStr;
    // ISO(yyyy-mm-dd)は既にゼロ埋め済み。samplesの "2026/06/01" 表記に合わせ、ゼロを残す。
    return parts[0] + '/' + parts[1] + '/' + parts[2];
  }

  // 入荷ウィザードの回答 → doPost用 fields（質問名は ponkichi_schema.md §A-1 と完全一致）
  function buildNyukaFields(answers) {
    const fieldKey = KUBUN_TO_FIELD[answers.kubun];
    if (!fieldKey) throw new Error('区分が不正です: ' + answers.kubun);
    const fields = {};
    fields[fieldKey] = answers.genryomei;
    fields['数量(g)'] = String(answers.suryo);
    fields['入荷日'] = toFormDate(answers.nyukabi);
    fields['仕入先'] = answers.shiirasaki;
    fields['メーカー'] = answers.maker;
    fields['記録者'] = answers.kirokusha;
    return fields;
  }

  function buildSummary(answers) {
    return answers.kubun + '「' + answers.genryomei + '」' + answers.suryo + 'g（' + answers.nyukabi + '）';
  }

  // キューに1件追加する（送信自体はここでは行わない。呼び出し側が直後にflushする想定）。
  function enqueue(answers) {
    const item = {
      uuid: uuid(),
      event_type: '入荷',
      fields: buildNyukaFields(answers),
      summary: buildSummary(answers),
      createdAt: new Date().toISOString(),
      status: 'pending',        // pending→sent→verified/held（要件§6-2）
      firstAttemptAt: null,
      verifyAttempts: 0,
      held: false,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    };
    const queue = App.Storage.getQueue();
    queue.push(item);
    App.Storage.setQueue(queue);
    // 前回値・候補の更新（次回入力の1タップ確定用）
    App.Storage.setLastRecorder(answers.kirokusha);
    App.Storage.setLastSupplier(answers.shiirasaki);
    App.Storage.setLastMaker(answers.maker);
    App.Storage.addSupplierCandidate(answers.shiirasaki);
    App.Storage.addMakerCandidate(answers.maker);
    return item;
  }

  // ============================================================
  // 送信方式v2（exactly-once）— 要件定義書 §6-2
  //
  // 【大原則】fetchの結果（成功・失敗・中断）は配達の証拠として一切信用しない。
  //   実測（複製・2026-07-30〜31）：ブラウザからのPOSTは応答が読めない。しかし
  //   途中でabortしても記帳は届いて着地する（5回のPOSTが全て正確に1行ずつ着地）。
  //   → 成否は必ず「アプリ記帳ログ」を読み戻して判定する。
  //
  // 状態機械：pending → sent → verified（履歴へ）/ held（要人間・自動再送しない）
  // ============================================================

  const APP_LOG_SHEET = 'アプリ記帳ログ';
  const POST_ABORT_MS = 3000;          // no-cors POSTは応答を読めないので短く打ち切る（送信自体は届く）
  let VERIFY_DELAYS_MS = [5000, 15000, 60000]; // 送信直後の3段階照合
  const MAX_VERIFY_ATTEMPTS = 3;       // 起動3回分照合しても不明ならheld

  // テスト専用：照合の待ち時間を短縮する（自動テストが実時間で待たないようにするためだけの入口）。
  // 本番動作では呼ばれない。
  function __setVerifyDelaysForTest(arr) { VERIFY_DELAYS_MS = arr; }

  // 伝票番号：項目UUIDの先頭8桁（GAS側の受付ログに記録される）
  function tokenOf(item) {
    return String(item.uuid).slice(0, 8);
  }

  // 「アプリ記帳ログ」を読み、伝票番号の集合を返す。読めなければ null（＝判定不能）。
  async function fetchAppLogTokens(bridgeUrl) {
    try {
      const url = bridgeUrl.replace(/\/$/, '') + '?action=read&sheet=' + encodeURIComponent(APP_LOG_SHEET);
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json) return null;
      if (json.success !== true) {
        // 「シートが見つかりません」＝受付台帳タブが未作成（初回送信前）。
        //   これは"分からない"ではなく"1件も着地していない"と確定できる状態なので、
        //   空の集合を返して送信を許可する（タブはGAS側が初回書き込み時に自動生成する）。
        //   一方それ以外のエラー（許可されていないシート名＝GAS未更新 等）は設定不備なので
        //   null（判定不能）のままにし、送信を止める。
        if (String(json.error || '').indexOf('シートが見つかりません') !== -1) return {};
        return null;
      }
      const set = {};
      (json.rows || []).forEach(function (r) {
        const t = String(r['伝票番号'] || '').trim();
        if (t) set[t] = true;
      });
      return set;
    } catch (err) {
      return null; // オフライン等。判定不能＝再送も消込もしない（安全側）
    }
  }

  // 1件をno-corsでPOSTする。応答は読めない前提で、結果は一切判定に使わない。
  async function firePost(bridgeUrl, item) {
    const payload = {
      event_type: item.event_type,
      fields: item.fields,
      sync_forms: false,
      // 受付台帳（アプリ記帳ログ）用。GAS側はこれが無ければ何もしない＝後方互換。
      app_log: {
        token: tokenOf(item),
        recorder: (item.fields && item.fields['記録者']) || '',
        summary: item.summary || '',
      },
    };
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, POST_ABORT_MS) : null;
    try {
      await fetch(bridgeUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (err) {
      // ⚠ ここで失敗しても「届いていない」証拠にはならない。何もしない（再送判断は読み戻しのみ）。
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function markVerified(item) {
    App.Storage.pushHistory({
      uuid: item.uuid,
      token: tokenOf(item),
      event_type: item.event_type,
      summary: item.summary,
      status: 'verified',
      sentAt: new Date().toISOString(),
      // 出荷のみ：在庫スナップショットより後に着地した分を差し引くために持ち越す。
      // キューから消えた時点で差し引きが効かなくなると、同じ在庫を二度出荷できてしまう。
      stockKey: item.stockKey || null,
      stockQty: item.stockQty || 0,
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // キューを古い順に処理する。
  // 戻り値：{ verified, sent, held, remaining, offline }
  async function flushQueue() {
    const bridgeUrl = App.Storage.getBridgeUrl();
    let queue = App.Storage.getQueue();
    if (!bridgeUrl || queue.length === 0) {
      return { verified: 0, sent: 0, held: 0, remaining: queue.length, offline: false,
               lastError: bridgeUrl ? null : '送信先URL未設定' };
    }

    // ── 手順1：送信前に受付台帳を読む（冪等ガード）──
    let tokens = await fetchAppLogTokens(bridgeUrl);
    if (tokens === null) {
      // 読めない＝オフライン等。POSTもしない（届いたか確認できない送信はしない）。
      return { verified: 0, sent: 0, held: 0, remaining: queue.length, offline: true,
               lastError: '受付台帳を読めませんでした（オフラインの可能性）' };
    }

    let verified = 0, sentCount = 0, heldCount = 0;
    const stillQueued = [];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!item.status) item.status = 'pending';
      if (item.verifyAttempts == null) item.verifyAttempts = 0;
      if (item.held) { heldCount += 1; stillQueued.push(item); continue; }

      const token = tokenOf(item);

      // 既に台帳にある → 送らずに確定（再送による二重記帳の防止）
      if (tokens[token]) {
        item.status = 'verified';
        markVerified(item);
        verified += 1;
        continue; // キューから外す
      }

      // 台帳に無いと確認できた場合のみPOSTしてよい
      if (!item.firstAttemptAt) item.firstAttemptAt = new Date().toISOString();
      item.attempts = (item.attempts || 0) + 1;
      item.lastAttemptAt = new Date().toISOString();
      await firePost(bridgeUrl, item);
      item.status = 'sent';

      // ── 手順3：3段階で読み戻し照合 ──
      let found = false;
      for (let d = 0; d < VERIFY_DELAYS_MS.length; d++) {
        await sleep(VERIFY_DELAYS_MS[d]);
        const t2 = await fetchAppLogTokens(bridgeUrl);
        if (t2 === null) break;      // 判定不能：sentのまま保持
        if (t2[token]) { found = true; tokens = t2; break; }
      }

      if (found) {
        item.status = 'verified';
        markVerified(item);
        verified += 1;
        continue; // キューから外す
      }

      // 見つからない：sentのまま保持し、次回起動時に手順1から再開
      item.verifyAttempts += 1;
      if (item.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        // ⚠ 自動再送はしない。人間がPonkichiを見て判断する（安全側に倒す）
        item.held = true;
        item.status = 'held';
        item.lastError = '送信したが台帳への着地を確認できませんでした（自動再送はしていません）';
        heldCount += 1;
      } else {
        sentCount += 1;
      }
      stillQueued.push(item);
    }

    App.Storage.setQueue(stillQueued);
    return { verified: verified, sent: sentCount, held: heldCount,
             remaining: stillQueued.length, offline: false, lastError: null };
  }

  // 未確認(sent)・要確認(held)の件数を返す（ホーム表示用）
  function queueStats() {
    const q = App.Storage.getQueue();
    let pending = 0, sent = 0, held = 0;
    q.forEach(function (it) {
      if (it.held || it.status === 'held') held += 1;
      else if (it.status === 'sent') sent += 1;
      else pending += 1;
    });
    return { pending: pending, sent: sent, held: held, total: q.length };
  }

  // キューから手動削除（送信不能な壊れた項目の後始末用・UIの任意機能）
  function removeFromQueue(uuidStr) {
    const queue = App.Storage.getQueue().filter(function (it) { return it.uuid !== uuidStr; });
    App.Storage.setQueue(queue);
  }

  // ============================================================
  // P2：欠減・測定（event_type=発酵管理 / processHakkoKanri）
  //   schema §A-3。BT移送は別（理由キーワードで自動計算が発火するため分離）。
  // ============================================================

  // ⚠ main.gs は「その他の欠減理由」にこれらの語を含むとBT受入量再計算・FG/度数更新を発火させる。
  //   欠減・測定フローでは誤発火を防ぐため、理由文にこれらが紛れ込んでいないか検査する（要件§9-2）。
  const FORBIDDEN_REASON_KEYWORDS = ['ブライトタンク移送', 'アルコール分析'];

  function reasonForbiddenHit(reason) {
    const s = String(reason || '');
    return FORBIDDEN_REASON_KEYWORDS.filter(function (kw) { return s.indexOf(kw) !== -1; });
  }

  // 欠減・測定の回答 → doPost用 fields（質問名は schema §A-3 と完全一致）
  //  kind: '比重測定' | 'アルコール分析' | '澱引き' | 'その他'
  function buildHakkoFields(answers) {
    const fields = {};
    fields['バッチNo'] = answers.batchNo;
    fields['記録日'] = toFormDate(answers.kirokubi);
    fields['記録者'] = answers.kirokusha;
    if (answers.kind === '比重測定' || answers.kind === 'アルコール分析') {
      if (answers.hijyu !== undefined && answers.hijyu !== '' && answers.hijyu !== null) {
        fields['現在の比重'] = String(answers.hijyu);
      }
      fields['測定に伴う欠減量(ml)'] = String(answers.sokuteiMl);
      if (answers.kind === 'アルコール分析') fields['測定種別'] = 'アルコール';
    } else {
      // 澱引き・その他（酵母投入後の物理ロス）
      fields['その他の欠減量(L)'] = String(answers.sonotaL);
      fields['その他の欠減理由'] = answers.riyu;
    }
    return fields;
  }

  function buildHakkoSummary(answers) {
    if (answers.kind === '比重測定' || answers.kind === 'アルコール分析') {
      return answers.batchNo + ' ' + answers.kind + '（' + (answers.sokuteiMl || 0) + 'ml・' + answers.kirokubi + '）';
    }
    return answers.batchNo + ' ' + answers.kind + '（' + (answers.sonotaL || 0) + 'L・' + answers.kirokubi + '）';
  }

  // キューに1件追加（発酵管理）。送信は呼び出し側が直後にflushする。
  function enqueueHakko(answers) {
    const hit = reasonForbiddenHit(answers.riyu);
    if (hit.length > 0) {
      throw new Error('理由に禁止語が含まれています（' + hit.join('・') + '）。BT移送・アルコール分析は専用フローで記録してください。');
    }
    const item = {
      uuid: uuid(),
      event_type: '発酵管理',
      fields: buildHakkoFields(answers),
      summary: buildHakkoSummary(answers),
      createdAt: new Date().toISOString(),
      status: 'pending',        // pending→sent→verified/held（要件§6-2）
      firstAttemptAt: null,
      verifyAttempts: 0,
      held: false,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    };
    const queue = App.Storage.getQueue();
    queue.push(item);
    App.Storage.setQueue(queue);
    App.Storage.setLastRecorder(answers.kirokusha);
    return item;
  }

  // ============================================================
  // P2：BT移送（event_type=発酵管理 / processHakkoKanri）
  //   ⚠ 欠減・測定とは逆に、理由に「ブライトタンク移送」を必ず含める。
  //     main.gs はこの語でBT受入量（仕込み液量−累積欠減）を自動計算し仕込み帳簿を更新する。
  //   ※「アルコール分析」の語はFG/度数の自動更新を誤発火させるため補足に混ぜない。
  // ============================================================
  function buildBTFields(answers) {
    const fields = {};
    fields['バッチNo'] = answers.batchNo;
    fields['記録日'] = toFormDate(answers.kirokubi);
    fields['記録者'] = answers.kirokusha;
    fields['移送先タンク番号'] = answers.transferTo;
    fields['その他の欠減量(L)'] = String(answers.gensuiL);
    fields['その他の欠減理由'] = 'ブライトタンク移送' + (answers.hosoku ? '（' + answers.hosoku + '）' : '');
    return fields;
  }

  function buildBTSummary(answers) {
    return answers.batchNo + ' BT移送→' + answers.transferTo + '（欠減' + (answers.gensuiL || 0) + 'L・' + answers.kirokubi + '）';
  }

  function enqueueBT(answers) {
    // 補足に「アルコール分析」が混じるとFG/度数を誤って書き換えるため拒否
    if (String(answers.hosoku || '').indexOf('アルコール分析') !== -1) {
      throw new Error('補足に「アルコール分析」は使えません（度数の誤更新を防ぐため）。別の言葉にしてください。');
    }
    const item = {
      uuid: uuid(),
      event_type: '発酵管理',
      fields: buildBTFields(answers),
      summary: buildBTSummary(answers),
      createdAt: new Date().toISOString(),
      status: 'pending',        // pending→sent→verified/held（要件§6-2）
      firstAttemptAt: null,
      verifyAttempts: 0,
      held: false,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    };
    const queue = App.Storage.getQueue();
    queue.push(item);
    App.Storage.setQueue(queue);
    App.Storage.setLastRecorder(answers.kirokusha);
    return item;
  }

  // ============================================================
  // P3：詰口（event_type=製品化 / processSeihinka）schema §A-4
  //   ⚠ キー「最終比重 (FG)」は (FG) の前に半角空白（厳守）。
  //   1送信=1容器（缶＋樽は別送信で繰り返す）。
  // ============================================================
  function buildSeihinFields(answers) {
    const fields = {};
    fields['バッチNo'] = answers.batchNo;
    fields['製品化（容器充填）日'] = toFormDate(answers.seihinbi);
    fields['完成製品名'] = answers.seihinmei;
    fields['容器'] = answers.youki;
    fields['完成数量（本）'] = String(answers.honsu);
    fields['パッケージ亡失量（mL）'] = String(answers.pkgLossMl);
    fields['このバッチの充填はこれで最後ですか？（タンクは空になりましたか？）'] = answers.isLast; // はい/いいえ
    // 「はい」のときだけGASが読む計算入力（schema §A-4）。
    //   ①工程内亡失(澱廃棄)の行を作る ②パッケージ欠減（残差）から差し引く、の2つに使われる。
    //   省略すると澱廃棄の行が立たず、その分がパッケージ欠減に乗る＝欠減の内訳が実態と食い違う。
    //   2026-10-19までアプリ側が送っておらず、Claude経路（brewlog_to_payload.py）だけが送っていた。
    if (answers.isLast === 'はい') {
      fields['タンク底の澱(L)'] = String(answers.oriL != null ? answers.oriL : 0);
    }
    if (answers.fg !== undefined && answers.fg !== '' && answers.fg !== null) {
      fields['最終比重 (FG)'] = String(answers.fg); // ⚠半角空白厳守・文字列で精度保持
    }
    if (answers.bikou) fields['備考'] = answers.bikou;
    fields['記録者'] = answers.kirokusha;
    return fields;
  }

  function buildSeihinSummary(answers) {
    return answers.batchNo + ' 詰口 ' + answers.seihinmei + '／' + answers.youki + '×' + answers.honsu + '本（' + answers.seihinbi + '）';
  }

  function enqueueSeihin(answers) {
    const item = {
      uuid: uuid(),
      event_type: '製品化',
      fields: buildSeihinFields(answers),
      summary: buildSeihinSummary(answers),
      createdAt: new Date().toISOString(),
      status: 'pending',        // pending→sent→verified/held（要件§6-2）
      firstAttemptAt: null,
      verifyAttempts: 0,
      held: false,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
    };
    const queue = App.Storage.getQueue();
    queue.push(item);
    App.Storage.setQueue(queue);
    App.Storage.setLastRecorder(answers.kirokusha);
    return item;
  }

  // ============================================================
  // P4：出荷（event_type=出荷 / processShukka）schema §A-6
  //
  // ⚠ GASは「出荷製品・バッチ」を **1本の文字列** で受け、2段の正規表現で
  //   製品名／容器／バッチNo に分解する：
  //     "PON IPA (缶（360ml）) (#26)" → beer_mei='PON IPA' / youki='缶（360ml）' / batch='#26'
  //   形が崩れると batchNo が '（不明）' のまま着地し、度数も総量(L)も引けない。
  //   そのため文字列は App.Masters.stockLabel（製品受払簿の実値から組む）で作り、手入力させない。
  // ⚠ 製品受払簿には「記録者」列が無い（14列）。記録者は台帳に載らず、
  //   アプリ記帳ログ（受付台帳）側にだけ残る。fields にも入れて経路を揃えておく（GAS側は無視）。
  // ============================================================
  function buildShukkaFields(answers) {
    const fields = {};
    fields['出荷日'] = toFormDate(answers.shukkabi);
    fields['出荷製品・バッチ'] = answers.productLabel;
    fields['出荷数量'] = String(answers.suryo);
    fields['出荷先'] = answers.shukkasaki;
    fields['出荷先区分'] = answers.shukkaKubun;
    if (answers.bikou) fields['摘要'] = answers.bikou; // GASは '備考' も '摘要' も見る（摘要=実フォームの列名）
    fields['記録者'] = answers.kirokusha;
    return fields;
  }

  function buildShukkaSummary(answers) {
    return '出荷 ' + answers.productLabel + ' ×' + answers.suryo + '（' +
      answers.shukkasaki + '・' + answers.shukkabi + '）';
  }

  function enqueueShukka(answers) {
    if (!answers.productLabel) throw new Error('出荷する製品が選ばれていません。');
    // GAS側の分解に失敗する形を、送る前にここで止める（'（不明）'バッチでの着地防止）
    if (!/^.+\s\(.+\)\s\(#\d+\)$/.test(answers.productLabel)) {
      throw new Error('製品の指定が「製品名 (容器) (#バッチ)」の形になっていません：' + answers.productLabel);
    }
    const item = {
      uuid: uuid(),
      event_type: '出荷',
      fields: buildShukkaFields(answers),
      summary: buildShukkaSummary(answers),
      createdAt: new Date().toISOString(),
      status: 'pending',        // pending→sent→verified/held（要件§6-2）
      firstAttemptAt: null,
      verifyAttempts: 0,
      held: false,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      // 在庫の二重払出を防ぐため、キューに残っている間は在庫から差し引く（出荷画面が参照する）
      stockKey: answers.productLabel,
      stockQty: Number(answers.suryo) || 0,
    };
    const queue = App.Storage.getQueue();
    queue.push(item);
    App.Storage.setQueue(queue);
    App.Storage.setLastRecorder(answers.kirokusha);
    App.Storage.setLastShipTo(answers.shukkasaki);
    return item;
  }

  // 在庫スナップショットに「まだ反映されていない」出荷の本数（label単位）。
  //   ①キューに残っている分（未送信・反映待ち・要確認）
  //   ②スナップショットを取った後に着地が確認できた分（履歴）
  // ②を数えないと、着地確認でキューから消えた直後に同じ在庫をもう一度出荷できてしまう
  //   （製品受払簿の在庫がマイナス＝台帳の誤りになる）。
  function reservedShukkaQty(label) {
    let n = 0;
    App.Storage.getQueue().forEach(function (it) {
      if (it.event_type === '出荷' && it.stockKey === label) n += (Number(it.stockQty) || 0);
    });
    const stock = App.Storage.getStock();
    const snapAt = stock && stock.fetchedAt ? new Date(stock.fetchedAt).getTime() : null;
    if (snapAt !== null) {
      App.Storage.getHistory().forEach(function (h) {
        if (h.event_type !== '出荷' || h.stockKey !== label) return;
        const t = h.sentAt ? new Date(h.sentAt).getTime() : 0;
        if (t > snapAt) n += (Number(h.stockQty) || 0);
      });
    }
    return n;
  }

  return {
    KUBUN_TO_FIELD,
    toFormDate,
    buildNyukaFields,
    buildSummary,
    enqueue,
    flushQueue,
    removeFromQueue,
    // P2
    FORBIDDEN_REASON_KEYWORDS,
    reasonForbiddenHit,
    buildHakkoFields,
    buildHakkoSummary,
    enqueueHakko,
    buildBTFields,
    buildBTSummary,
    enqueueBT,
    // P3
    buildSeihinFields,
    buildSeihinSummary,
    enqueueSeihin,
    // P4
    buildShukkaFields,
    buildShukkaSummary,
    enqueueShukka,
    reservedShukkaQty,
    queueStats,
    __setVerifyDelaysForTest,
    checkBikoForbidden,
  };
})();
