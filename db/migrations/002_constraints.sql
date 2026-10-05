ALTER TABLE trading_audit ADD CONSTRAINT trading_audit_previous_hash_fk CHECK (previous_hash IS NULL OR previous_hash <> hash);
ALTER TABLE trading_risk_configs ADD CONSTRAINT trading_risk_configs_config_object_chk CHECK (jsonb_typeof(config)='object');
ALTER TABLE trading_checkpoints ADD CONSTRAINT trading_checkpoints_snapshot_object_chk CHECK (jsonb_typeof(snapshot)='object');
