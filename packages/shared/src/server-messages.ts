/**
 * 서버가 한국어로 만든 문장(API 오류, 예약 주문 실패 사유, 브래킷 메모 등)을 화면 언어로 옮긴다.
 *
 * 서버 코드는 그대로 한국어 문장을 던지고, 웹이 받은 문장을 이 표의 틀에 맞춰 옮긴다. 틀의 {이름}은 아무 글자와
 * 맞고, 옮긴 문장의 같은 {이름} 자리에 그대로 들어간다. 맞는 틀이 없으면 원문(한국어)을 보여 준다.
 * 새 오류 문구를 추가하면 여기에도 추가할 것 (웹 `node scripts/i18n-missing.mjs --server`로 빠진 것을 찾는다).
 */
import type { Locale } from "./i18n";

/** [한국어 틀, 영어, 일본어] */
export type ServerMessage = readonly [string, string, string];

export const SERVER_MESSAGES: readonly ServerMessage[] = [
  ["계좌를 찾을 수 없습니다", "Account not found", "口座が見つかりません"],
  ["사용할 수 없는 닉네임입니다", "That nickname can't be used", "使用できないニックネームです"],
  ["비밀번호는 4자 이상이어야 합니다", "The password must be at least 4 characters", "パスワードは4文字以上にしてください"],
  ["이미 사용 중인 닉네임입니다", "That nickname is already taken", "すでに使われているニックネームです"],
  ["닉네임 또는 비밀번호가 올바르지 않습니다", "Wrong nickname or password", "ニックネームまたはパスワードが正しくありません"],
  ["계좌가 없습니다", "No account", "口座がありません"],
  ["관리자 닉네임은 변경할 수 없습니다", "The admin nickname can't be changed", "管理者のニックネームは変更できません"],
  ["새 비밀번호는 4자 이상이어야 합니다", "The new password must be at least 4 characters", "新しいパスワードは4文字以上にしてください"],
  ["사용자를 찾을 수 없습니다", "User not found", "ユーザーが見つかりません"],
  ["현재 비밀번호가 올바르지 않습니다", "The current password is wrong", "現在のパスワードが正しくありません"],
  ["인증 토큰이 필요합니다", "Please log in", "ログインが必要です"],
  ["유효하지 않은 토큰입니다", "Your session has expired. Please log in again", "セッションの有効期限が切れました。もう一度ログインしてください"],
  ["시도가 너무 많습니다. {s}초 뒤 다시 시도하세요", "Too many attempts. Try again in {s} seconds", "試行回数が多すぎます。{s}秒後にもう一度お試しください"],
  ["매일 04:10~04:20(한국 시간)은 점검 시간입니다. 04:20 이후 다시 시도해 주세요.", "04:10–04:20 (KST) is daily maintenance. Please try again after 04:20.", "毎日04:10〜04:20（韓国時間）はメンテナンス時間です。04:20以降にもう一度お試しください。"],
  ["서버 점검 중입니다. 잠시 후 다시 이용해 주세요.", "The server is under maintenance. Please try again shortly.", "サーバーメンテナンス中です。しばらくしてから再度ご利用ください。"],
  ["옵션 상품 추가·선물 개선 업데이트 점검입니다 ({time}). 점검 중에는 주문·취소가 중단됩니다.", "Maintenance for the options and futures update ({time}). Orders and cancellations are paused during maintenance.", "オプション追加・先物改善のアップデートメンテナンスです（{time}）。メンテナンス中は注文・取消が停止します。"],
  ["원자재지수(KCOM) 옵션 추가 업데이트 점검입니다 ({time}). 점검 중에는 주문·취소가 중단됩니다.", "Maintenance for the commodity index (KCOM) options update ({time}). Orders and cancellations are paused during maintenance.", "商品指数（KCOM）オプション追加のアップデートメンテナンスです（{time}）。メンテナンス中は注文・取消が停止します。"],
  ["{what} 업데이트 점검입니다 ({time}). 점검 중에는 주문·취소가 중단됩니다.", "Update maintenance: {what} ({time}). Orders and cancellations are paused during maintenance.", "{what}のアップデートメンテナンスです（{time}）。メンテナンス中は注文・取消が停止します。"],
  ["없는 선물: {symbol}", "No such futures contract: {symbol}", "存在しない先物：{symbol}"],
  ["레버리지는 1~{max}배 정수입니다", "Leverage must be a whole number from 1 to {max}", "レバレッジは1〜{max}倍の整数です"],
  ["포지션이 있는 동안에는 레버리지를 바꿀 수 없습니다. 청산한 뒤 바꿔 주세요", "Leverage can't be changed while you hold a position. Close it first", "ポジション保有中はレバレッジを変更できません。決済してから変更してください"],
  ["미체결 주문이 있는 동안에는 레버리지를 바꿀 수 없습니다", "Leverage can't be changed while you have open orders", "未約定注文がある間はレバレッジを変更できません"],
  ["없는 종목: {symbol}", "No such symbol: {symbol}", "存在しない銘柄：{symbol}"],
  ["지수 구간이 없습니다", "No index data", "指数の区間がありません"],
  ["지원하지 않는 봉 간격: {interval}", "Unsupported candle interval: {interval}", "対応していない足の間隔：{interval}"],
  ["없는 기초자산: {code}", "No such underlying: {code}", "存在しない原資産：{code}"],
  ["없는 산업군: {id}", "No such industry: {id}", "存在しない業種：{id}"],
  ["손절과 익절 중 하나는 입력해 주세요", "Enter a stop-loss or a take-profit", "損切りか利確のどちらかを入力してください"],
  ["손절 거리는 {min}%~{max}% 사이여야 합니다", "The stop distance must be between {min}% and {max}%", "損切り幅は{min}%〜{max}%の間にしてください"],
  ["익절 거리는 {min}%~{max}% 사이여야 합니다", "The take-profit distance must be between {min}% and {max}%", "利確幅は{min}%〜{max}%の間にしてください"],
  ["자동 보호 설정을 찾을 수 없습니다", "Auto-protection setting not found", "自動保護の設定が見つかりません"],
  ["이미 등록됐거나 취소된 설정입니다", "This setting was already applied or canceled", "すでに登録済みか取り消された設定です"],
  ["사용자 취소", "Canceled by you", "ユーザーが取消"],
  ["이미 처리된 설정입니다", "This setting was already processed", "すでに処理された設定です"],
  ["체결 없이 종결된 주문", "The order closed without a fill", "約定せずに終了した注文"],
  ["손절선 이미 도달", "stop level already reached", "損切りラインに到達済み"],
  ["익절선 이미 도달", "take-profit level already reached", "利確ラインに到達済み"],
  ["{reason} → 즉시 시장가 매도 ({id})", "{reason} → sold at market immediately ({id})", "{reason} → 直ちに成行売り（{id}）"],
  ["{reason}, 즉시 매도 실패: {error}", "{reason}, immediate sale failed: {error}", "{reason}、即時売却に失敗：{error}"],
  ["OCO 등록 손절 {stop} / 익절 {take} ({id})", "OCO set: stop {stop} / take profit {take} ({id})", "OCO登録 損切り {stop} / 利確 {take}（{id}）"],
  ["손절 등록 {price} ({id})", "Stop set at {price} ({id})", "損切りを登録 {price}（{id}）"],
  ["익절 등록 {price} ({id})", "Take profit set at {price} ({id})", "利確を登録 {price}（{id}）"],
  ["등록 재시도 대기: {message}", "Waiting to retry: {message}", "登録の再試行待ち：{message}"],
  ["OCO 짝 주문 발동으로 자동 취소", "Canceled automatically because its OCO pair triggered", "OCOの対の注文が発動したため自動取消"],
  ["청산할 선물 포지션이 없어 자동 취소", "Canceled automatically: no futures position left to close", "決済する先物ポジションがないため自動取消"],
  ["지정가는 양의 정수", "The limit price must be a positive whole number", "指値は正の整数にしてください"],
  ["{symbol}의 호가 단위는 {tick}입니다", "{symbol} trades in ticks of {tick}", "{symbol}の呼値は{tick}です"],
  ["트레일링 거리는 {min}%~{max}% 사이여야 합니다", "The trailing distance must be between {min}% and {max}%", "トレーリング幅は{min}%〜{max}%の間にしてください"],
  ["트레일링 거리가 너무 좁아 등록 즉시 발동합니다", "The trailing distance is so tight it would trigger immediately", "トレーリング幅が狭すぎて登録と同時に発動します"],
  ["트리거 가격은 양의 정수", "The trigger price must be a positive whole number", "トリガー価格は正の整数にしてください"],
  ["아래 트리거는 위 트리거보다 낮아야 합니다", "The lower trigger must be below the upper trigger", "下のトリガーは上のトリガーより低くしてください"],
  ["수량은 양의 정수", "The quantity must be a positive whole number", "数量は正の整数にしてください"],
  ["선물 예약 주문은 보유 포지션을 청산하는 방향으로만 걸 수 있습니다", "Futures conditional orders can only close a position you hold", "先物の予約注文は保有ポジションを決済する方向にのみ設定できます"],
  ["청산할 수 있는 수량은 {n}계약입니다", "You can close up to {n} contracts", "決済できる数量は{n}枚です"],
  ["현재가 {price}이 이미 {trigger} 이상 조건을 만족합니다. 일반 주문을 이용하세요", "The current price {price} is already at or above {trigger}. Use a regular order", "現在値{price}がすでに{trigger}以上の条件を満たしています。通常の注文をご利用ください"],
  ["현재가 {price}이 이미 {trigger} 이하 조건을 만족합니다. 일반 주문을 이용하세요", "The current price {price} is already at or below {trigger}. Use a regular order", "現在値{price}がすでに{trigger}以下の条件を満たしています。通常の注文をご利用ください"],
  ["대기 중인 예약 주문은 계정당 {n}건까지입니다", "You can have up to {n} conditional orders waiting", "待機中の予約注文は1アカウントあたり{n}件までです"],
  ["예약 주문을 찾을 수 없습니다", "Conditional order not found", "予約注文が見つかりません"],
  ["이미 발동됐거나 취소된 예약 주문입니다", "This conditional order already triggered or was canceled", "すでに発動済みか取り消された予約注文です"],
  ["이미 발동된 예약 주문입니다", "This conditional order already triggered", "すでに発動した予約注文です"],
  ["OCO 짝 주문 취소", "Canceled with its OCO pair", "OCOの対の注文を取消"],
  ["주문 접수 실패", "Order could not be placed", "注文受付に失敗"],
  ["거래가 끝난 옵션입니다. 보유분 매도만 할 수 있습니다", "This option has been retired. You can only sell what you hold", "取引が終了したオプションです。保有分の売却のみ可能です"],
  ["옵션은 보유한 수량만 매도(청산)할 수 있습니다", "You can only sell (close) options you hold", "オプションは保有数量のみ売却（決済）できます"],
  ["거래가 끝난 옵션은 새로 쓸 수 없습니다", "Retired options can't be written", "取引が終了したオプションは新規に売り建てできません"],
  ["만기가 지난 옵션입니다", "This option has expired", "満期を過ぎたオプションです"],
  ["오늘의 행사가가 아직 정해지지 않았습니다", "Today's strikes haven't been set yet", "本日の権利行使価格はまだ決まっていません"],
  ["자동 손절/익절은 매수 주문에만 붙일 수 있습니다", "Automatic stop / take profit can only be attached to buy orders", "自動損切り・利確は買い注文にのみ付けられます"],
  ["같은 멱등 키의 주문이 아직 처리 중입니다. 잠시 후 다시 조회하세요", "An order with the same idempotency key is still being processed. Check again shortly", "同じ冪等キーの注文がまだ処理中です。しばらくしてから再度確認してください"],
  ["한 주문의 수량은 {n}주까지입니다", "Up to {n} shares per order", "1回の注文数量は{n}株までです"],
  ["지정가는 {n}원까지입니다", "Limit prices go up to ₩{n}", "指値は₩{n}までです"],
  ["옵션은 한 주문에 {n}계약까지입니다", "Up to {n} option contracts per order", "オプションは1回の注文で{n}枚までです"],
  ["선물은 한 주문에 {n}계약까지입니다", "Up to {n} futures contracts per order", "先物は1回の注文で{n}枚までです"],
  ["주문 증거금이 부족합니다", "Not enough margin for this order", "注文証拠金が不足しています"],
  ["쓰기 증거금이 부족합니다", "Not enough margin to write this option", "売り建て証拠金が不足しています"],
  ["주문 가능 금액이 부족합니다", "Not enough available cash", "注文可能額が不足しています"],
  ["매도 가능 수량이 부족합니다", "Not enough shares to sell", "売却可能数量が不足しています"],
  ["주문을 찾을 수 없습니다", "Order not found", "注文が見つかりません"],
  ["본인 주문만 취소할 수 있습니다", "You can only cancel your own orders", "自分の注文のみ取り消せます"],
  ["이미 종결된 주문입니다 ({status})", "This order is already closed ({status})", "すでに終了した注文です（{status}）"],
  ["본인 주문만 정정할 수 있습니다", "You can only amend your own orders", "自分の注文のみ訂正できます"],
  ["지정가 주문만 정정할 수 있습니다", "Only limit orders can be amended", "指値注文のみ訂正できます"],
  ["정정 가격은 양의 정수", "The new price must be a positive whole number", "訂正価格は正の整数にしてください"],
  ["정정 수량은 양의 정수", "The new quantity must be a positive whole number", "訂正数量は正の整数にしてください"],
  ["바뀐 내용이 없습니다", "Nothing changed", "変更内容がありません"],
  ["취소 확인이 지연돼 새 주문을 내지 않았습니다. 잠시 후 다시 시도하세요", "Cancel confirmation was delayed, so no new order was placed. Try again shortly", "取消の確認が遅れたため新しい注文は出していません。しばらくしてから再度お試しください"],
  ["취소 전에 전량 체결됐습니다", "It was fully filled before it could be canceled", "取消前に全量約定しました"],
  ["손절", "Stop", "損切り"],
  ["익절", "Take profit", "利確"],
  ["손절 매도", "Stop-loss sell", "損切り売り"],
  ["익절 매도", "Take-profit sell", "利確売り"],
  ["돌파 매수", "Breakout buy", "ブレイクアウト買い"],
  ["눌림 매수", "Buy the dip", "押し目買い"],
  ["{n}원", "₩{n}", "₩{n}"],
];

interface Compiled {
  regex: RegExp;
  names: string[];
  en: string;
  ja: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let compiled: Compiled[] | null = null;
function compile(): Compiled[] {
  if (compiled) return compiled;
  compiled = SERVER_MESSAGES.map(([ko, en, ja]) => {
    const names: string[] = [];
    const pattern = ko
      .split(/(\{\w+\})/g)
      .map((part) => {
        const match = /^\{(\w+)\}$/.exec(part);
        if (!match) return escapeRegex(part);
        names.push(match[1]);
        return "([\\s\\S]*?)";
      })
      .join("");
    return { regex: new RegExp(`^${pattern}$`), names, en, ja };
  });
  return compiled;
}

/** 서버 문장 → 화면 언어. 한국어이거나 맞는 틀이 없으면 그대로. 끼워 넣은 값도 다시 옮겨 본다(중첩 사유). */
export function localizeServerMessage(message: string, locale: Locale, depth = 0): string {
  if (locale === "ko" || !message) return message;
  for (const entry of compile()) {
    const match = entry.regex.exec(message);
    if (!match) continue;
    const values: Record<string, string> = {};
    entry.names.forEach((name, index) => {
      const value = match[index + 1];
      values[name] = depth < 2 ? localizeServerMessage(value, locale, depth + 1) : value;
    });
    const target = locale === "en" ? entry.en : entry.ja;
    return target.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);
  }
  return message;
}
