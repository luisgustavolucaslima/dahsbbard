const puppeteer = require('puppeteer');
const fs = require('fs');

async function gerarCardapio() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <style>
        body { font-family: Arial; padding: 20px; }
        .produto { margin-bottom: 10px; }
      </style>
      <body>
        <h1>Cardápio Atualizado</h1>
        <div class="produto">🍔 X-Burguer - R$ 10,00</div>
        <div class="produto">🍟 Batata - R$ 6,00</div>
      </body>
    </html>
  `);

  await page.screenshot({ path: 'cardapio.png', fullPage: true });
  await browser.close();
}

gerarCardapio();
