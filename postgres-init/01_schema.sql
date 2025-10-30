-- Схема CRM
CREATE TABLE IF NOT EXISTS customers (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  amount       NUMERIC(12,2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'paid',
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Немного стартовых данных
INSERT INTO customers (name,email) VALUES
  ('Bob','bob@example.com'),
  ('Carol','carol@example.com');

INSERT INTO orders (customer_id,amount,status) VALUES
  (1, 50.00,  'paid'),
  (1, 25.25,  'paid'),
  (2, 10.00,  'canceled');
