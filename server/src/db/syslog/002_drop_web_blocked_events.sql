-- Blocked web requests used to be kept as events, one row each; a busy network made thousands an hour and they buried the events that matter.
-- They are counted by site in the hourly summary now. The rows that were already written are removed.
DELETE FROM syslog_events WHERE kind = 'web_blocked';
