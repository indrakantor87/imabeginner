# FBS Market Analyzer Bot - Dokumentasi Lengkap

## 1. Deskripsi Umum
Bot ini adalah sistem trading otomatis (Expert Advisor) berbasis **Node.js** yang dirancang untuk menganalisa pasar Forex dan Crypto secara real-time menggunakan indikator teknikal canggih. Bot ini bekerja sebagai "Otak" yang mengirimkan sinyal eksekusi ke MetaTrader 5 (MT5) melalui koneksi lokal.

Bot ini memiliki kemampuan **Self-Learning (Kecerdasan Buatan Sederhana)** yang memungkinkannya untuk menghindari pair (pasangan mata uang) yang memiliki performa buruk berdasarkan sejarah tradingnya sendiri.

---

## 2. Fitur Utama & Strategi

### A. Mode Trading
Bot memiliki 2 mode strategi yang bisa diganti secara real-time:

1.  **SNIPER Mode (Reversal)**
    *   **Filosofi:** Mencari titik balik harga (Buy di bawah, Sell di atas).
    *   **Indikator:** RSI (Relative Strength Index) + Bollinger Bands.
    *   **Sinyal BUY:** RSI < 30 (Jenuh Jual) DAN Harga menembus Lower Band Bollinger.
    *   **Sinyal SELL:** RSI > 70 (Jenuh Beli) DAN Harga menembus Upper Band Bollinger.
    *   **Cocok untuk:** Pasar Sideways (datar).

2.  **PREDATOR Mode (Trend Follower)**
    *   **Filosofi:** Mengikuti arus besar (Trend is Friend).
    *   **Indikator:** MACD (Momentum) + EMA 200 (Trend Jangka Panjang).
    *   **Sinyal BUY:** Histogram MACD Positif Kuat DAN Harga di ATAS EMA 200.
    *   **Sinyal SELL:** Histogram MACD Negatif Kuat DAN Harga di BAWAH EMA 200.
    *   **Cocok untuk:** Pasar Trending (naik/turun kuat).

### B. Money Management (Manajemen Risiko)
*   **Auto-Compounding:** Lot size menyesuaikan saldo secara otomatis.
    *   *Rumus:* `(Equity / RiskFactor) * 0.01`
    *   *Contoh:* Modal $150 = 0.01 Lot. Modal $1500 = 0.10 Lot.
*   **Dynamic SL/TP (ATR Based):** Stop Loss dan Take Profit tidak statis (angka mati), tapi menyesuaikan volatilitas pasar menggunakan ATR (Average True Range).
    *   *Stop Loss:* 1.5x ATR (Jarak aman).
    *   *Take Profit:* 2.0x ATR (Target optimis).
*   **Max Daily Loss (Circuit Breaker):** Jika rugi harian mencapai batas tertentu (default $100), bot otomatis BERHENTI trading hari itu.

### C. Self-Learning (Brain)
*   Bot mencatat setiap kemenangan dan kekalahan di file `brain.json`.
*   **Aturan Cerdas:** Jika suatu pair sudah ditradingkan minimal 5 kali dan Win Rate-nya < 30%, bot akan mem-blacklist pair tersebut ("Brain Block").

---

## 3. Struktur Teknis (Fungsi Kode)

Berikut adalah fungsi-fungsi inti dalam kode `index.js`:

| Nama Fungsi | Deskripsi & Tugas |
| :--- | :--- |
| `analyzeMarket(pair, periods)` | **Jantung Bot.** Menerima data candle dari TradingView, menghitung indikator (RSI, MACD, EMA, BB), dan memutuskan Signal (BUY/SELL/WAIT). |
| `openPosition(...)` | Menghitung Lot Size, SL, TP, dan mengirimkan perintah order ke antrian (`signalQueue`) untuk diambil oleh MT5. |
| `updateBrain(pair, profit)` | Mencatat hasil trading (Profit/Loss) ke memori otak bot (`brain.json`) untuk evaluasi masa depan. |
| `api/update_balance` | Menerima laporan dari MT5. Melakukan sinkronisasi posisi, mendeteksi posisi yang ditutup manual, dan mengupdate saldo. |
| `io.on('connection')` | Mengelola koneksi ke Dashboard UI (Browser/HP) via Socket.io untuk tampilan real-time. |
| `Auto-Cleanup (15s)` | Menghapus posisi "Pending" yang tidak dikonfirmasi MT5 dalam 15 detik (mencegah posisi hantu). |

---

## 4. Cara Menjalankan

### A. Persiapan MetaTrader 5 (WAJIB UPDATE)
Karena ada penambahan fitur **Trailing Stop**, kode EA (Expert Advisor) di MT5 **HARUS DIPERBARUI**.
1.  Ambil file `FBSBot.mq5` yang ada di folder ini.
2.  Buka MetaEditor (di MT5 tekan F4).
3.  Compile file tersebut.
4.  Pasang EA baru ke chart di MT5.
    *   *Pastikan URL di input EA adalah `http://127.0.0.1:3006` (atau sesuaikan dengan setting WebRequest)*
    *   *Pastikan "Allow WebRequest" aktif di Tools > Options > Expert Advisors.*
    *   *Masukkan URL `http://127.0.0.1:3006` ke dalam daftar WebRequest.*

### B. Mode Independen (Tanpa Membuka Kode)
Cukup klik 2x file **`FBSBot.exe`**. Bot akan berjalan di layar hitam (CMD).

### B. Monitoring (Dashboard)
Buka browser (Chrome) di Laptop atau HP (satu WiFi):
*   `http://localhost:3006` (Di Laptop)
*   `http://[IP-Laptop]:3006` (Di HP)

### C. Reset Otak
Jika ingin menghapus ingatan bot (agar mulai belajar dari nol), hapus file `brain.json` dan `trade_history.json` saat bot mati.

---
**Dibuat oleh:** Trae AI Assistant (Feb 2026)
**Versi:** 1.2 (Stable + Brain Enabled)
