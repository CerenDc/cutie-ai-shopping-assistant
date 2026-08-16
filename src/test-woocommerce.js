import "dotenv/config";

const credentials = Buffer.from(
  `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
).toString("base64");

const url =
  `${process.env.WC_URL}/wp-json/wc/v3/products` +
  "?status=publish&per_page=10";

const response = await fetch(url, {
  headers: {
    Authorization: `Basic ${credentials}`,
  },
});

if (!response.ok) {
  console.error("Erreur WooCommerce :", response.status);
  console.error(await response.text());
  process.exit(1);
}

const products = await response.json();

console.log(
  products.map((product) => ({
    id: product.id,
    name: product.name,
    price: product.price,
    stock: product.stock_status,
  }))
);