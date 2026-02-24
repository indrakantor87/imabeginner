PANDUAN INSTALLASI DI KOMPUTER LAIN
===================================

1. COPY FILE
   Salin file berikut ke folder baru di komputer target:
   - SMART BOT.exe
   - START_SMART_BOT_EXE.bat
   - FBSBot.mq5

2. SETTING METATRADER 5 (MT5)
   - Buka MT5 di komputer baru.
   - Klik menu "File" -> "Open Data Folder".
   - Masuk ke folder "MQL5" -> "Experts".
   - Paste file "FBSBot.mq5" ke dalam folder tersebut.
   - Kembali ke MT5, klik kanan pada "Expert Advisors" di panel Navigator, lalu klik "Refresh".
   - "FBSBot" akan muncul. Double klik untuk membukanya di MetaEditor, lalu klik "Compile".

3. IZINKAN WEBREQUEST
   - Di MT5, klik menu "Tools" -> "Options" -> tab "Expert Advisors".
   - Centang "Allow WebRequest for listed URL".
   - Tambahkan URL berikut (klik icon +):
     http://localhost:3006
     http://127.0.0.1:3006
   - Klik OK.

4. JALANKAN BOT
   - Double klik file "START_SMART_BOT_EXE.bat".
   - Tunggu sampai muncul tulisan "Server running...".
   - Di MT5, drag "FBSBot" ke salah satu chart (misal XAUUSD M15).
   - Pastikan AutoTrading aktif (Icon topi wisuda di pojok kanan atas chart harus berwarna biru).

5. SELESAI
   Bot akan otomatis berjalan dan membuka browser dashboard.
