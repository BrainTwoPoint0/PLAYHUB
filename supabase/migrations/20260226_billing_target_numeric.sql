-- Change daily_recording_target from integer to numeric to support decimal targets (e.g. 2.3)
ALTER TABLE playhub_venue_billing_config
  ALTER COLUMN daily_recording_target TYPE NUMERIC(5,1)
  USING daily_recording_target::NUMERIC(5,1);

-- Set Nazwa's target to 2.3 per agreement (Section 6.3: break-even 2.3 recordings/day/camera)
UPDATE playhub_venue_billing_config
  SET daily_recording_target = 2.3
  WHERE organization_id = '218da56d-b525-469d-878d-2093dce1800c';
