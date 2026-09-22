-- 회원가입·로그인이 닉네임+비밀번호만 쓰도록: 닉네임이 로그인 ID가 되어 유일해야 하고,
-- 이메일은 봇·관리자 같은 시스템 계정의 내부 식별자로만 남는다(사용자 가입 시 NULL).

-- 1) 기존 중복 닉네임은 뒤에 id 앞 4자리를 붙여 갈라놓는다(먼저 만든 계정이 원래 이름을 지킨다).
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY nickname ORDER BY created_at, id) AS rn
  FROM "auth"."users"
)
UPDATE "auth"."users" u
SET nickname = u.nickname || '_' || substr(u.id::text, 1, 4)
FROM ranked r
WHERE r.id = u.id AND r.rn > 1;

-- 2) 이메일 선택 사항 (UNIQUE는 NULL을 여러 개 허용한다)
ALTER TABLE "auth"."users" ALTER COLUMN "email" DROP NOT NULL;

-- 3) 닉네임 유일
CREATE UNIQUE INDEX "users_nickname_key" ON "auth"."users"("nickname");
