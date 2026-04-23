-- Guard profiles.is_platform_admin against self-elevation
--
-- Context: the existing RLS policy "Users can update own profile" had no column
-- restriction, so any authenticated user could UPDATE profiles SET
-- is_platform_admin = true via the anon key. Now that is_platform_admin is
-- honored by the central isVenueAdmin helper (~40 endpoints), that column must
-- be write-gated at the database level.
--
-- Rule: a caller may set or clear is_platform_admin only if they already hold
-- the flag, or if they have no JWT context (service role / migrations / DB
-- triggers — where auth.uid() returns NULL). Any other write path is rejected
-- with SQLSTATE 42501.

CREATE OR REPLACE FUNCTION public.guard_platform_admin_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_uid uuid := auth.uid();
  caller_is_admin boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_platform_admin IS NOT DISTINCT FROM OLD.is_platform_admin THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.is_platform_admin IS NOT TRUE THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Service role / migration / db-trigger context: auth.uid() is NULL. Allow.
  IF caller_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Authenticated caller: must currently hold the flag themselves.
  SELECT is_platform_admin
    INTO caller_is_admin
    FROM public.profiles
   WHERE user_id = caller_uid;

  IF caller_is_admin IS TRUE THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Modifying is_platform_admin requires platform admin privileges'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS guard_platform_admin_write ON public.profiles;

CREATE TRIGGER guard_platform_admin_write
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.guard_platform_admin_write();
