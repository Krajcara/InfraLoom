-- Mail that was filed as "no report" before the module could read a report that arrives as an attached message (Google does that)
-- is read again: those rows are forgotten, and the mailbox is read from the beginning of the first-read period once more.
-- Reports already stored are not touched, and a message that was processed is skipped as always.
DELETE FROM dmarc_messages WHERE status = 'no-report';
DELETE FROM dmarc_state WHERE key = 'graph_cursor';
