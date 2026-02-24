//+------------------------------------------------------------------+
//|                                                       FBSBot.mq5 |
//|                                  Copyright 2024, FBS Market Team |
//|                                             https://www.fbs.com/ |
//+------------------------------------------------------------------+
#property copyright "Copyright 2024, FBS Market Team"
#property link      "https://www.fbs.com/"
#property version   "2.00"
#property strict

//+------------------------------------------------------------------+
//| Input Parameters                                                 |
//+------------------------------------------------------------------+
input string   ServerURL            = "http://127.0.0.1:3006"; // Node.js Server URL (Updated IP)
input int      MagicNumber          = 123456;                  // Magic Number
input double   EquityProtectionPercent = 15.0;                 // Equity Protection (Stop trading if equity drops X%)
input double   TargetProfitPercent     = 5.0;                  // Daily Target Profit (%)
input bool     UseLocalTrailing        = true;                 // Enable Local Trailing Stop
input int      TrailingStartPoints     = 150;                  // Trailing Start (Points)
input int      TrailingStepPoints      = 50;                   // Trailing Step (Points)

//+------------------------------------------------------------------+
//| Global Variables                                                 |
//+------------------------------------------------------------------+
#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

CTrade trade;
CPositionInfo positionInfo;

string pairs[] = {"XAUUSD", "EURUSD", "GBPUSD", "USDCAD", "USDJPY", "USDCHF", "BTCUSD", "GBPJPY"};
int current_pair_idx = 0;
int current_tf_mode = 0; // 0=M15, 1=M5

long last_signal_id = 0;
datetime last_connection_time = 0;
bool is_trading_allowed = true;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   // Allow WebRequest
   if(!TerminalInfoInteger(TERMINAL_DLLS_ALLOWED))
     {
      Print("Error: DLLs are not allowed. Please enable DLL imports.");
     }
     
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
     {
      Print("Error: AutoTrading is disabled. Please enable AutoTrading.");
     }

   trade.SetExpertMagicNumber(MagicNumber);
   
   EventSetMillisecondTimer(200); // Check signals and send data rapidly (5Hz)
   
   Print("FBSBot v2.00 Initialized. Connecting to ", ServerURL);
   Print("Data Source: DIRECT MT5 FEED (8 Pairs)");
   
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   Print("FBSBot Deinitialized.");
  }

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
  {
   if(!is_trading_allowed) return;

   // 1. Safety Checks
   CheckEquityProtection();
   
   // 2. Local Trailing Stop (Reduces Latency)
   if(UseLocalTrailing)
   {
      CheckTrailingStop();
   }
  }

//+------------------------------------------------------------------+
//| Timer function (Signal Fetching + Data Sending)                  |
//+------------------------------------------------------------------+
void OnTimer()
  {
   // 1. Get Signals (Only if trading allowed)
   if(is_trading_allowed)
   {
      GetAndExecuteSignal();
   }
   
   // 2. Send Market Data (ALWAYS SEND, even if trading stopped)
   // This ensures Dashboard stays synced regardless of Equity Protection status
   
   string symbol = pairs[current_pair_idx];
   ENUM_TIMEFRAMES tf = (current_tf_mode == 0) ? PERIOD_M15 : PERIOD_M5;
   string tfStr = (current_tf_mode == 0) ? "15" : "5";
   
   // Debug Print (Once per cycle to verify Timer is working)
   if(current_pair_idx == 0 && current_tf_mode == 0) 
   {
      // Also Send Balance Info Periodically
      SendBalanceInfo();
   }
   
   SendMarketData(symbol, tf, tfStr);
   
   // Advance Cycle
   current_tf_mode++;
   if(current_tf_mode > 1) 
   {
      current_tf_mode = 0;
      current_pair_idx++;
      if(current_pair_idx >= ArraySize(pairs)) current_pair_idx = 0;
   }
  }

//+------------------------------------------------------------------+
//| Trade Event: Triggered when positions change                     |
//+------------------------------------------------------------------+
void OnTrade()
{
   // Instant Sync when trade opens/closes/modifies
   SendBalanceInfo();
}

//+------------------------------------------------------------------+
//| Send Full Account State (Balance + Positions) to Node.js         |
//+------------------------------------------------------------------+
void SendBalanceInfo()
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   
   // Start JSON Construction
   string json = StringFormat("{\"balance\":%.2f,\"equity\":%.2f,\"positions\":[", balance, equity);
   
   // Iterate Open Positions
   int total = PositionsTotal();
   for(int i=0; i<total; i++)
   {
      if(positionInfo.SelectByIndex(i))
      {
         if(positionInfo.Symbol() != "") // Basic check
         {
             ulong ticket = positionInfo.Ticket();
             string sym = positionInfo.Symbol();
             ENUM_POSITION_TYPE type = positionInfo.PositionType();
             string typeStr = (type == POSITION_TYPE_BUY) ? "BUY" : "SELL";
             double vol = positionInfo.Volume();
             double price = positionInfo.PriceOpen();
             double profit = positionInfo.Profit();
             
             string posJson = StringFormat("{\"ticket\":\"%I64u\",\"pair\":\"%s\",\"type\":\"%s\",\"lot\":%.2f,\"openPrice\":%.5f,\"profit\":%.2f}",
                                           ticket, sym, typeStr, vol, price, profit);
             
             json += posJson;
             if(i < total - 1) json += ",";
         }
      }
   }
   
   json += "]}"; // Close JSON
   
   string url = ServerURL + "/api/update_balance";
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   StringToCharArray(json, postData, 0, StringLen(json));
   ArrayResize(postData, StringLen(json));
   
   char result[];
   string resultHeaders;
   
   int res = WebRequest("POST", url, headers, 100, postData, result, resultHeaders);
   
   if (res != 200)
   {
      Print("SYNC FAILED! Balance/Positions. Code: ", res, " Err: ", GetLastError());
   }
   else
   {
      // Optional: Success Log (Uncomment if needed)
      // Print("Sync OK: ", total, " Pos. Bal: ", balance);
   }
}

//+------------------------------------------------------------------+
//| Send Market Data to Node.js                                      |
//+------------------------------------------------------------------+
void SendMarketData(string rawSymbol, ENUM_TIMEFRAMES tf, string tfStr)
{
   string symbol = FixSymbol(rawSymbol);
   if(symbol == "") return;
   
   MqlRates rates[];
   ArraySetAsSeries(rates, false); // Normal order (oldest first)
   
   // Copy last 250 candles (enough for EMA 200)
   int copied = CopyRates(symbol, tf, 0, 250, rates);
   
   if(copied > 0)
   {
      string json = FormatCandlesJSON(rawSymbol, tfStr, rates, copied);
      
      string url = ServerURL + "/api/mt5/market_data";
      string headers = "Content-Type: application/json\r\n";
      char postData[];
      // IMPORTANT: Copy ONLY the string length, exclude the terminating null (\0)
      StringToCharArray(json, postData, 0, StringLen(json));
      
      // CRITICAL FIX: Resize array to exact length to avoid garbage characters
      ArrayResize(postData, StringLen(json));
      
      char result[];
      string resultHeaders;
      
      // Send Request (Ignore result to speed up, just fire and forget logic mostly)
      int res = WebRequest("POST", url, headers, 100, postData, result, resultHeaders);
      
      // DEBUG: Print result if failed
      if (res != 200)
      {
         Print("Data Send Failed! Code: ", res, " Error: ", GetLastError(), " URL: ", url);
         if (res == -1) Print("Check: Tools > Options > Expert Advisors > Allow WebRequest");
      }
      else
      {
         // Print("Data Sent OK: ", symbol); // Uncomment to confirm success
      }
   }
}

//+------------------------------------------------------------------+
//| Helper: Format Candles to JSON                                   |
//+------------------------------------------------------------------+
string FormatCandlesJSON(string symbol, string tf, MqlRates &rates[], int count)
{
   string json = "{\"symbol\":\"" + symbol + "\",\"timeframe\":\"" + tf + "\",\"candles\":[";
   
   for(int i=0; i<count; i++)
   {
      string candle = StringFormat("{\"time\":%d,\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f}",
                                   rates[i].time, rates[i].open, rates[i].high, rates[i].low, rates[i].close);
      
      json += candle;
      if(i < count - 1) json += ",";
   }
   
   json += "]}";
   return json;
}

//+------------------------------------------------------------------+
//| Advanced Feature: Equity Protection (Hard Stop)                  |
//+------------------------------------------------------------------+
void CheckEquityProtection()
{
   if(EquityProtectionPercent <= 0 && TargetProfitPercent <= 0) return;
   
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   
   // Max Drawdown Check
   if(EquityProtectionPercent > 0)
   {
      double minEquity = balance * (1.0 - (EquityProtectionPercent / 100.0));
      if(equity < minEquity)
      {
         Print("CRITICAL: Equity Protection Triggered! Closing ALL Positions.");
         CloseAllPositions();
         is_trading_allowed = false;
         Print("Trading HALTED due to Equity Protection.");
         return;
      }
   }
   
   // Target Profit Check (Secure Wins)
   if(TargetProfitPercent > 0)
   {
      double targetEquity = balance * (1.0 + (TargetProfitPercent / 100.0));
      if(equity >= targetEquity)
      {
         Print("SUCCESS: Target Profit Reached! Closing ALL Positions.");
         CloseAllPositions();
         is_trading_allowed = false;
         Print("Trading PAUSED due to Target Profit Reached.");
      }
   }
}

//+------------------------------------------------------------------+
//| Advanced Feature: Trailing Stop (Local)                          |
//+------------------------------------------------------------------+
void CheckTrailingStop()
{
   double trailingPoints = TrailingStartPoints * _Point; 
   double stepPoints = TrailingStepPoints * _Point;
   
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      if(positionInfo.SelectByIndex(i))
      {
         if(positionInfo.Magic() != MagicNumber) continue;

         double sl = positionInfo.StopLoss();
         double price = positionInfo.PriceCurrent();
         double openPrice = positionInfo.PriceOpen();
         ulong ticket = positionInfo.Ticket();
         
         if(positionInfo.PositionType() == POSITION_TYPE_BUY)
         {
            // If Price > Open + Activation
            if(price > (openPrice + trailingPoints))
            {
               double newSL = price - trailingPoints;
               if(sl == 0 || newSL > (sl + stepPoints))
               {
                  if(trade.PositionModify(ticket, newSL, positionInfo.TakeProfit()))
                     Print("Trailing Stop Updated (BUY): ", ticket, " New SL: ", newSL);
               }
            }
         }
         else if(positionInfo.PositionType() == POSITION_TYPE_SELL)
         {
            // If Price < Open - Activation
            if(price < (openPrice - trailingPoints))
            {
               double newSL = price + trailingPoints;
               if(sl == 0 || newSL < (sl - stepPoints))
               {
                  if(trade.PositionModify(ticket, newSL, positionInfo.TakeProfit()))
                     Print("Trailing Stop Updated (SELL): ", ticket, " New SL: ", newSL);
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Close All Positions                                              |
//+------------------------------------------------------------------+
void CloseAllPositions()
{
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      if(positionInfo.SelectByIndex(i))
      {
         if(positionInfo.Magic() == MagicNumber)
         {
            trade.PositionClose(positionInfo.Ticket());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Get Signal from Node.js                                          |
//+------------------------------------------------------------------+
void GetAndExecuteSignal()
{
   string url = ServerURL + "/api/signal?last_id=" + IntegerToString(last_signal_id);
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   char result[];
   string resultHeaders;
   
   int res = WebRequest("GET", url, headers, 500, postData, result, resultHeaders);
   
   if(res == 200)
   {
      string jsonRes = CharArrayToString(result);
      
      // Basic JSON Parsing (Assumes simple structure)
      long id = GetJsonValueInt(jsonRes, "id");
      
      if(id > last_signal_id && id != 0)
      {
         last_signal_id = id;
         string action = GetJsonValueString(jsonRes, "action");
         
         Print("Received Signal ID: ", id, " Action: ", action);
         
         if(action == "OPEN")
         {
            string symbol = GetJsonValueString(jsonRes, "symbol");
            if(symbol == "") symbol = GetJsonValueString(jsonRes, "pair");
            
            // Fix Symbol Suffix (e.g. XAUUSD -> XAUUSD.m)
            string tradeSymbol = FixSymbol(symbol);
            if(tradeSymbol == "") 
            {
               Print("Error: Symbol not found: ", symbol);
               return;
            }
            
            string typeStr = GetJsonValueString(jsonRes, "type");
            ENUM_ORDER_TYPE type = (typeStr == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
            
            double lot = GetJsonValueDouble(jsonRes, "lot");
            double sl = GetJsonValueDouble(jsonRes, "sl");
            double tp = GetJsonValueDouble(jsonRes, "tp");
            string comment = GetJsonValueString(jsonRes, "comment");
            
            double price = (type == ORDER_TYPE_BUY) ? SymbolInfoDouble(tradeSymbol, SYMBOL_ASK) : SymbolInfoDouble(tradeSymbol, SYMBOL_BID);
            
            if(trade.PositionOpen(tradeSymbol, type, lot, price, sl, tp, comment))
            {
               Print("Order Executed: ", tradeSymbol, " ", typeStr, " Lot: ", lot);
            }
            else
            {
               Print("Order Failed: ", GetLastError());
            }
         }
         else if(action == "CLOSE")
         {
            ulong ticket = (ulong)GetJsonValueInt(jsonRes, "ticket");
            if(ticket > 0) trade.PositionClose(ticket);
         }
         else if(action == "MODIFY")
         {
            ulong ticket = (ulong)GetJsonValueInt(jsonRes, "ticket");
            double sl = GetJsonValueDouble(jsonRes, "sl");
            double tp = GetJsonValueDouble(jsonRes, "tp");
            if(ticket > 0) trade.PositionModify(ticket, sl, tp);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Helper: Fix Symbol Suffix                                        |
//+------------------------------------------------------------------+
string FixSymbol(string symbol)
{
   if(SymbolSelect(symbol, true)) return symbol;
   
   string suffixes[] = {".m", ".pro", "_i", ".c", ".ecn", "m", "pro"};
   for(int i=0; i<ArraySize(suffixes); i++)
   {
      string temp = symbol + suffixes[i];
      if(SymbolSelect(temp, true)) return temp;
   }
   
   return "";
}

//+------------------------------------------------------------------+
//| Helper: Simple JSON Parsers                                      |
//+------------------------------------------------------------------+
string GetJsonValueString(string json, string key)
{
   int keyPos = StringFind(json, "\"" + key + "\"");
   if(keyPos < 0) return "";
   
   int startPos = StringFind(json, ":", keyPos);
   if(startPos < 0) return "";
   
   int valStart = StringFind(json, "\"", startPos);
   if(valStart < 0) return "";
   
   int valEnd = StringFind(json, "\"", valStart + 1);
   if(valEnd < 0) return "";
   
   return StringSubstr(json, valStart + 1, valEnd - valStart - 1);
}

long GetJsonValueInt(string json, string key)
{
   // Handle both string and number formats in JSON
   int keyPos = StringFind(json, "\"" + key + "\"");
   if(keyPos < 0) return 0;
   
   int startPos = StringFind(json, ":", keyPos);
   if(startPos < 0) return 0;
   
   // Find value start (skip whitespace and potential quote)
   int valStart = startPos + 1;
   while(valStart < StringLen(json) && (StringGetCharacter(json, valStart) == ' ' || StringGetCharacter(json, valStart) == '"'))
      valStart++;
      
   // Find value end (comma, closing brace, or closing quote)
   int valEnd = valStart;
   while(valEnd < StringLen(json))
   {
      ushort c = StringGetCharacter(json, valEnd);
      if(c == ',' || c == '}' || c == '"') break;
      valEnd++;
   }
   
   string val = StringSubstr(json, valStart, valEnd - valStart);
   return StringToInteger(val);
}

double GetJsonValueDouble(string json, string key)
{
   int keyPos = StringFind(json, "\"" + key + "\"");
   if(keyPos < 0) return 0.0;
   
   int startPos = StringFind(json, ":", keyPos);
   if(startPos < 0) return 0.0;
   
   int valStart = startPos + 1;
   while(valStart < StringLen(json) && (StringGetCharacter(json, valStart) == ' ' || StringGetCharacter(json, valStart) == '"'))
      valStart++;
      
   int valEnd = valStart;
   while(valEnd < StringLen(json))
   {
      ushort c = StringGetCharacter(json, valEnd);
      if(c == ',' || c == '}' || c == '"') break;
      valEnd++;
   }
   
   string val = StringSubstr(json, valStart, valEnd - valStart);
   return StringToDouble(val);
}
