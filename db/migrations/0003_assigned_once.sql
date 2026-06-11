-- 親子提醒:一次性(臨時)提醒 — assigned_reminders 加 once_date
-- NULL      = 每日/週循環(用 days_of_week 判斷)
-- 'YYYY-MM-DD' = 只在該日觸發一次(臨時提醒,過期由 cron 清掉)
ALTER TABLE assigned_reminders ADD COLUMN once_date TEXT;
