-- ============================================================================
--  영시미 — 로그인/프로필 서버 설정 (2026-11-19)
--  Supabase 대시보드 → SQL Editor 에 이 파일을 그대로 붙여 넣고 Run 한 번.
--  이미 있는 것을 다시 실행해도 안전하도록 if not exists / drop policy 로 썼습니다.
--  프로젝트: unoeugpeoxfbvdccqwxr (https://unoeugpeoxfbvdccqwxr.supabase.co)
-- ============================================================================

-- 1) 프로필 테이블 — 로그인한 사람마다 한 줄. id 는 auth.users 의 id 와 같습니다.
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  nickname     text,
  age_group    text check (age_group in ('10대', '20대', '30대', '40대 이상')),
  height_cm    smallint,
  eye_cm       smallint,
  favorites    jsonb default '[]'::jsonb,   -- [{tid,hid,seat,t,h,at}, ...]
  seen_movies  jsonb default '[]'::jsonb,   -- ['영화 제목', ...]
  consent_at   timestamptz,                 -- 개인정보 수집·이용 동의 시각
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_own_select" on public.profiles;
drop policy if exists "profiles_own_insert" on public.profiles;
drop policy if exists "profiles_own_update" on public.profiles;
create policy "profiles_own_select" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_own_insert" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_own_update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- 2) 후기를 계정에 연결(선택) — 로그인한 사람이 남긴 후기에 user_id 가 붙습니다.
--    이 컬럼이 없어도 사이트는 닉네임만으로 후기를 저장합니다.
alter table public.seat_reviews
  add column if not exists user_id uuid references auth.users (id) on delete set null;

-- ============================================================================
-- 2-1) 내 후기 수정·삭제 권한 (RLS) — 2026-11-20 추가
--    로그인한 사람이 '본인이 쓴 후기'만 고치고(UPDATE) 지울 수(DELETE) 있게 한다.
--    이 정책이 없으면 앱이 PATCH/DELETE 를 보내도 Supabase 는 오류 대신 200 + 빈 배열로 조용히 막는다.
--    그래서 화면에는 '이 기기에서만 반영됐다'는 안내만 뜨고, 다른 사람에게는 예전 후기가 그대로 남는다.
--    (drop policy if exists 로 썼으므로 여러 번 실행해도 안전합니다.)
-- ============================================================================
drop policy if exists "seat_reviews update own" on public.seat_reviews;
drop policy if exists "seat_reviews delete own" on public.seat_reviews;
create policy "seat_reviews update own" on public.seat_reviews
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "seat_reviews delete own" on public.seat_reviews
  for delete using (auth.uid() = user_id);

-- ============================================================================
-- 2-2) (선택·권장) user_id 위조 방지 — 남의 계정 id 로 후기를 심지 못하게 한다
--    위 수정·삭제 정책은 '행의 user_id 가 진짜 그 사람 것'이라는 전제로 동작한다.
--    추가(restrictive) 정책이라 기존 insert 정책을 막지 않고 함께 검사한다.
--    앱은 로그인 사용자 id 또는 null 만 보내므로 이 정책을 켜도 저장은 그대로 됩니다.
-- ============================================================================
drop policy if exists "seat_reviews insert own user_id" on public.seat_reviews;
create policy "seat_reviews insert own user_id" on public.seat_reviews
  as restrictive for insert with check (user_id is null or user_id = auth.uid());

-- ============================================================================
-- 2-3) (참고) 예전에 '수정할 때마다 새 행'이 쌓인 중복 후기 확인·정리
--    먼저 아래 select 로 무엇이 중복인지 눈으로 확인하세요(실행만 해서는 아무것도 지워지지 않습니다).
-- ----------------------------------------------------------------------------
-- select user_id, hall_key, seat_id, count(*) as cnt, min(created_at) as first, max(created_at) as last
--   from public.seat_reviews
--  where user_id is not null
--  group by 1,2,3 having count(*) > 1
--  order by cnt desc;
--
--  확인한 뒤 '같은 사람·같은 좌석의 가장 최근 한 건만 남기고' 지우려면(주석을 풀고 실행):
-- delete from public.seat_reviews r using public.seat_reviews k
--  where r.user_id = k.user_id and r.hall_key = k.hall_key and r.seat_id = k.seat_id
--    and r.created_at < k.created_at;

-- ============================================================================
-- 2-4) 확인용으로 남은 probe 행 정리 (2026-11-20 RLS 실측 때 넣은 행)
-- ============================================================================
delete from public.seat_reviews where hall_key = '__probe';
delete from public.seat_review_helpful where target_key = 'probe:rls-20261120';

-- ============================================================================
--  확인용 (Run 하면 아래 결과가 나옵니다)
-- ============================================================================
select 'profiles' as table_name, count(*) as rows from public.profiles;
-- seat_reviews 에 걸린 정책 목록 — update/delete own 두 줄이 보이면 정상입니다.
select polname as policy, polcmd as cmd, pg_get_expr(polqual, polrelid) as using_expr
  from pg_policy where polrelid = 'public.seat_reviews'::regclass
  order by polname;

-- ============================================================================
--  이어서 대시보드에서 직접 해야 하는 두 가지 (SQL 로는 안 됩니다)
-- ----------------------------------------------------------------------------
--  A. Authentication → URL Configuration
--     Site URL          : https://yeongsimi.kr/
--     Redirect URLs     : https://yeongsimi.kr/
--                         https://www.yeongsimi.kr/
--     (로컬에서도 시험하려면 http://localhost:8000/ 같은 주소를 한 줄 더 추가)
--
--  B. Authentication → Providers
--     Google : Google Cloud Console → 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션)
--              승인된 리디렉션 URI 에
--                https://unoeugpeoxfbvdccqwxr.supabase.co/auth/v1/callback
--              를 넣고, 받은 클라이언트 ID / 보안 비밀을 Supabase Google 항목에 붙여 저장.
--     Kakao  : 카카오 로그인은 쓰지 않기로 했습니다(2026-11-19 사용자 결정) — 대시보드에서 꺼 두십시오.
--     Google 항목을 저장하기 전에는 사이트에서 누르면
--     "구글 로그인이 아직 연결 설정 중이에요. 아래 이메일로 먼저 가입할 수 있어요."
--     안내가 뜨고 이메일 가입으로 넘어갑니다.
-- ============================================================================
