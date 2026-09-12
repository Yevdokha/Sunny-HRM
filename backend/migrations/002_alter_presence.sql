-- додаємо значення 'vacation' до статусу присутності (для 🌴 «У відпустці»)
ALTER TYPE presence_status ADD VALUE IF NOT EXISTS 'vacation';
