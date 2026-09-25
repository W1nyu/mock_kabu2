import { redirect } from "next/navigation";

/** 이체 기능은 없앴다. 예전 주소(북마크·알림 링크)는 같은 자리의 랭킹으로 보낸다. */
export default function TransferRedirect() {
  redirect("/ranking");
}
