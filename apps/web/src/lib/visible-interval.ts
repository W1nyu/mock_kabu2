/**
 * 탭이 보일 때만 도는 주기 실행. 숨겨진 탭(다른 탭·최소화·폰 잠금)에서는 요청을 보내지 않고,
 * 다시 보이는 순간 놓친 주기가 있으면 한 번 바로 실행해 화면을 최신으로 맞춘다.
 *
 * 동시 접속자가 늘 때 서버 부하의 대부분은 열어 두기만 한 탭들의 폴링이다. 실시간 값은 소켓이
 * 계속 밀어 주므로, 폴링은 보이는 화면의 보조 갱신으로만 충분하다.
 *
 * @returns 정리 함수 (clearInterval 대신 호출)
 */
export function everyVisible(fn: () => void, ms: number): () => void {
  if (typeof document === "undefined") return () => {};
  let missed = false;

  const timer = window.setInterval(() => {
    if (document.visibilityState === "hidden") {
      missed = true;
      return;
    }
    fn();
  }, ms);

  const onVisibility = () => {
    if (document.visibilityState !== "visible" || !missed) return;
    missed = false;
    fn();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
