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
--  확인용 (Run 하면 아래 결과가 나옵니다)
-- ============================================================================
select 'profiles' as table_name, count(*) as rows from public.profiles;

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
