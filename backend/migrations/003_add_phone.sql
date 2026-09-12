-- телефон співробітника (був у інтерфейсі, додаємо в базу)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';
