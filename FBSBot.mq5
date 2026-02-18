//+------------------------------------------------------------------+
//|                                                       FBSBot.mq5 |
//|                                  Copyright 2026, Trae Assistant  |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Trae Assistant"
#property link      "https://www.mql5.com"
#property version   "1.30"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- Input Parameters
input string BaseURL = "http://127.0.0.1:3006"; // Node.js Bot URL (Must match MT5 Allowed URL)
input int    TimerMs = 200;                     // Sync Interval (FASTER: 200ms)

//--- Global Objects
CTrade trade;
CPositionInfo positionInfo;
long last_signal_id = 0;
datetime last_ohlc_m15 = 0;
datetime last_ohlc_m5 = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   // Allow WebRequest
   if(!TerminalInfoInteger(TERMINAL_COMMUNITY_ACCOUNT))
      Print("Note: Ensure WebRequest is enabled for ", BaseURL);
      
   EventSetMillisecondTimer(TimerMs);
   
   // Configure Magic Number if needed
   trade.SetExpertMagicNumber(123456);
   
   // Set Default Filling (will be overridden in Execute)
   trade.SetTypeFilling(ORDER_FILLING_IOC); 
   
   Print("FBSBot EA Started. Connected to ", BaseURL);
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Helper: Execute with Retry (Filling Modes)                       |
//+------------------------------------------------------------------+
bool ExecuteOrder(string symbol, ENUM_ORDER_TYPE type, double volume, double price, double sl, double tp, string comment)
{
   // Array of filling modes to try
   ENUM_ORDER_TYPE_FILLING fillings[3];
   fillings[0] = ORDER_FILLING_IOC; // Usually best for ECN
   fillings[1] = ORDER_FILLING_FOK; // Required by some brokers
   fillings[2] = ORDER_FILLING_RETURN; // Standard
   
   // Check Symbol Support
   int fillingMode = (int)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   
   for(int i=0; i<3; i++)
   {
      // Force try everything if first attempt fails or mode seems restrictive
      // (Some brokers report wrong capabilities)
      
      trade.SetTypeFilling(fillings[i]);
      
      bool res = false;
      if(type == ORDER_TYPE_BUY)
         res = trade.Buy(volume, symbol, price, sl, tp, comment);
      else if(type == ORDER_TYPE_SELL)
         res = trade.Sell(volume, symbol, price, sl, tp, comment);
         
      if(res) 
      {
         Print("Order Executed! Mode: ", EnumToString(fillings[i]));
         return true;
      }
      
      int err = GetLastError();
      if(err != 10030 && err != 4756) 
      {
         // If error is NOT related to filling/connection, don't retry other modes
         Print("Order Failed (Non-Filling Error): ", err);
         return false; 
      }
      
      Print("Retry with different filling... (Prev Error: ", err, ")");
   }
   
   return false;
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   Print("FBSBot EA Stopped.");
  }

//+------------------------------------------------------------------+
//| Timer function                                                   |
//+------------------------------------------------------------------+
void OnTimer()
  {
   // 1. Check for Signals (PRIORITY)
   if(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
     {
      GetAndExecuteSignal();
     }
   else
     {
      static bool warned = false;
      if(!warned) { Print("WARNING: AutoTrading is DISABLED in MT5!"); warned = true; }
     }

   // 2. Send Status Update (Balance, Equity, Positions)
   SendStatusUpdate();
   SendOhlcUpdate();
   // 3. Simple On-Chart Status
   Comment("✅ ONLINE\n", BaseURL, "\nEquity: ", DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2));
  }

void SendOhlcForTf(string symbol, ENUM_TIMEFRAMES tf, string tfKey, datetime &last_time)
  {
   MqlRates rates[];
   int copied = CopyRates(symbol, tf, 0, 60, rates);
   if(copied <= 0) return;
   ArraySetAsSeries(rates, true);
   datetime latest = rates[0].time;
   if(latest == last_time) return;
   last_time = latest;

   string url = BaseURL + "/api/mt5/price";
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   char result[];
   string resultHeaders;

   int count = copied;
   if(count > 60) count = 60;

   string json = "{";
   json += "\"symbol\":\"" + symbol + "\",";
   json += "\"timeframe\":\"" + tfKey + "\",";
   json += "\"candles\":[";

   for(int i=count-1; i>=0; i--)
     {
      if(i < count-1) json += ",";
      json += "{";
      json += "\"time\":" + IntegerToString((int)rates[i].time) + ",";
      json += "\"open\":" + DoubleToString(rates[i].open, _Digits) + ",";
      json += "\"high\":" + DoubleToString(rates[i].high, _Digits) + ",";
      json += "\"low\":" + DoubleToString(rates[i].low, _Digits) + ",";
      json += "\"close\":" + DoubleToString(rates[i].close, _Digits);
      json += "}";
     }

   json += "]}";

   int len = StringToCharArray(json, postData, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(postData, len - 1);

   ResetLastError();
   int res = WebRequest("POST", url, headers, 500, postData, result, resultHeaders);
   if(res == -1)
     {
      int err = GetLastError();
      if(err != 4060) Print("OHLC Sync Failed: ", err);
     }
  }

void SendOhlcUpdate()
  {
   string symbol = _Symbol;
   SendOhlcForTf(symbol, PERIOD_M15, "15", last_ohlc_m15);
   SendOhlcForTf(symbol, PERIOD_M5, "5", last_ohlc_m5);
  }

//+------------------------------------------------------------------+
//| Send Status to Node.js                                           |
//+------------------------------------------------------------------+
void SendStatusUpdate()
  {
   string url = BaseURL + "/api/update_balance";
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   char result[];
   string resultHeaders;
   
   // Build JSON Payload
   string json = "{";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"positions\":[";
   
   int total = PositionsTotal();
   int count = 0;
   for(int i=0; i<total; i++)
     {
      if(positionInfo.SelectByIndex(i))
        {
         if(count > 0) json += ",";
         json += "{";
         json += "\"ticket\":\"" + IntegerToString(positionInfo.Ticket()) + "\",";
         json += "\"symbol\":\"" + positionInfo.Symbol() + "\",";
         json += "\"type\":" + IntegerToString(positionInfo.PositionType()) + ","; // 0=BUY, 1=SELL
         json += "\"volume\":" + DoubleToString(positionInfo.Volume(), 2) + ",";
         json += "\"openPrice\":" + DoubleToString(positionInfo.PriceOpen(), 5) + ",";
         json += "\"sl\":" + DoubleToString(positionInfo.StopLoss(), 5) + ",";
         json += "\"tp\":" + DoubleToString(positionInfo.TakeProfit(), 5) + ",";
         json += "\"profit\":" + DoubleToString(positionInfo.Profit(), 2);
         json += "}";
         count++;
        }
     }
   json += "]}";
   
   // Convert to Array (UTF-8 and remove Null Terminator)
   int len = StringToCharArray(json, postData, 0, WHOLE_ARRAY, CP_UTF8);
   if (len > 0) ArrayResize(postData, len - 1); // Remove trailing null byte
   
   // Send Request (NO RETRY LOOP - Fail Fast to keep EA responsive)
   ResetLastError();
   int res = WebRequest("POST", url, headers, 500, postData, result, resultHeaders);
   
   if(res == -1)
     {
      int err = GetLastError();
      // Only print critical errors, ignore timeouts to reduce log spam
      if(err != 4060) Print("Sync Failed: ", err); 
      
      if(err == 4060)
        {
         static bool alerted = false;
         if(!alerted) 
           {
            Print("CRITICAL: WebRequest Not Allowed for ", BaseURL);
            Alert("Please Enable WebRequest for ", BaseURL);
            alerted = true;
           }
        }
     }
   else if(res != 200)
     {
      Print("Server Error (HTTP ", res, ")");
     }
  }

//+------------------------------------------------------------------+
//| Get Signal from Node.js                                          |
//+------------------------------------------------------------------+
void GetAndExecuteSignal()
  {
   string url = BaseURL + "/api/signal?last_id=" + IntegerToString(last_signal_id);
   string headers = "";
   char postData[];
   char result[];
   string resultHeaders;
   
   int res = WebRequest("GET", url, headers, 500, postData, result, resultHeaders);
   
   if(res == 200)
     {
      string jsonRes = CharArrayToString(result);
      
      // Simple parsing (avoid complex JSON libs for speed/compatibility)
      // Expect format: {"id":123, "action":"OPEN", ...}
      
      long id = GetJsonValueInt(jsonRes, "id");
      
      if(id > last_signal_id)
        {
         last_signal_id = id;
         string action = GetJsonValueString(jsonRes, "action");
         
         Print("Received Signal ID: ", id, " Action: ", action);
         
         if(action == "OPEN")
           {
            string symbol = GetJsonValueString(jsonRes, "symbol");
            if(symbol == "") symbol = GetJsonValueString(jsonRes, "pair"); // Fallback
            
            if(symbol == "")
              {
               Print("ERROR: Received Signal with EMPTY Symbol! ID: ", id);
               return;
              }
              
            string type = GetJsonValueString(jsonRes, "type");
            double lot = GetJsonValueDouble(jsonRes, "lot");
            double sl = GetJsonValueDouble(jsonRes, "sl");
            double tp = GetJsonValueDouble(jsonRes, "tp");
            
            // 1. Fix Symbol Name (Handle Suffixes like .m, .pro)
            string tradeSymbol = symbol;
            
            // Try raw symbol first
            if(!SymbolSelect(tradeSymbol, true))
              {
               // Try Suffixes
               string suffixes[] = {".m", ".pro", "_i", "c", ".ecn", ".std", "micro", ".r", ".k", ".p", "op", "i"};
               bool found = false;
               for(int i=0; i<ArraySize(suffixes); i++)
                 {
                  string test = symbol + suffixes[i];
                  if(SymbolSelect(test, true))
                    {
                     tradeSymbol = test;
                     found = true;
                     break;
                    }
                 }
                 
               if(!found)
                 {
                  Print("ERROR: Symbol not found in Market Watch: ", symbol);
                  return;
                 }
              }

            // 2. Validate Parameters
            if(lot <= 0) { Print("ERROR: Invalid Lot Size: ", lot); return; }
            
            // 3. Adjust SL/TP for Minimum Stop Level (Safety)
            double point = SymbolInfoDouble(tradeSymbol, SYMBOL_POINT);
            double stopLevel = (double)SymbolInfoInteger(tradeSymbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
            // Ensure stopLevel is at least 2 points
            if(stopLevel == 0) stopLevel = 2 * point; 
            
            double ask = SymbolInfoDouble(tradeSymbol, SYMBOL_ASK);
            double bid = SymbolInfoDouble(tradeSymbol, SYMBOL_BID);
            double safeDist = stopLevel + (5 * point); // Add 5 points buffer
            
            double finalSL = sl;
            double finalTP = tp;
            
            // Adjust if too close
            if(type == "BUY")
              {
               if(finalSL > (bid - safeDist)) finalSL = bid - safeDist;
               if(finalTP > 0 && finalTP < (bid + safeDist)) finalTP = bid + safeDist;
              }
            else if(type == "SELL")
              {
               if(finalSL < (ask + safeDist)) finalSL = ask + safeDist;
               if(finalTP > 0 && finalTP > (ask - safeDist)) finalTP = ask - safeDist;
              }

            // Normalize
            int digits = (int)SymbolInfoInteger(tradeSymbol, SYMBOL_DIGITS);
            if(digits > 0)
              {
               finalSL = NormalizeDouble(finalSL, digits);
               finalTP = NormalizeDouble(finalTP, digits);
              }
            
            Print("EXECUTING ", type, " on ", tradeSymbol, " | Lot:", lot, " | SL:", finalSL, " | TP:", finalTP);
            
            // 4. Execute with Retry Logic
            bool result = false;
            string comment = "TraeBot"; 
            
            // Debug Parsing
            Print("PARSED EXEC: Symbol=", tradeSymbol, " Lot=", lot, " SL=", finalSL, " TP=", finalTP);

            if(type == "BUY")
               result = ExecuteOrder(tradeSymbol, ORDER_TYPE_BUY, lot, 0, finalSL, finalTP, comment);
            else if(type == "SELL")
               result = ExecuteOrder(tradeSymbol, ORDER_TYPE_SELL, lot, 0, finalSL, finalTP, comment);
               
            if(!result)
              {
               int err = GetLastError();
               Print("ORDER FAILED FINAL! Error Code: ", err);
               
               // --- ECN RETRY LOGIC (Error 10016: Invalid Stops) ---
               if(err == 10016)
                 {
                  Print("Retrying without SL/TP (ECN Mode)...");
                  if(type == "BUY")
                     result = ExecuteOrder(tradeSymbol, ORDER_TYPE_BUY, lot, 0, 0, 0, comment);
                  else if(type == "SELL")
                     result = ExecuteOrder(tradeSymbol, ORDER_TYPE_SELL, lot, 0, 0, 0, comment);
                     
                  if(result)
                    {
                     ulong ticket = trade.ResultOrder();
                     Print("ECN Entry Success! Ticket: ", ticket, ". Now applying SL/TP...");
                     Sleep(500); // Wait a bit for server
                     if(trade.PositionModify(ticket, finalSL, finalTP))
                        Print("SL/TP Applied Successfully.");
                     else
                        Print("Failed to apply SL/TP: ", GetLastError());
                    }
                 }
               
               if(!result)
               {
                   if(err == 10013) Print("Hint: Invalid Request. Check Stops Level.");
                   if(err == 10014) Print("Hint: Invalid Volume. Check Min/Max Lot.");
                   if(err == 10015) Print("Hint: Invalid Price (Quote changed).");
                   if(err == 10016) Print("Hint: Invalid Stops (SL/TP too close).");
                   if(err == 10027) Print("Hint: Enable AutoTrading in MT5 & EA Settings!");
                   if(err == 10030) Print("Hint: Unsupported Filling Mode.");
                   if(err == 4756) Print("Hint: Trade Request Sending Failed.");
               }
              }
           }
         else if(action == "CLOSE")
           {
            long ticket = (long)GetJsonValueDouble(jsonRes, "ticket"); // Usually passed as number
            
            // Log Attempt
            Print("Request CLOSE Ticket: ", ticket);
            
            if(ticket > 0)
              {
               bool res = trade.PositionClose(ticket);
               if(res) Print("CLOSE SUCCESS: ", ticket);
               else Print("CLOSE FAILED: ", ticket, " Error: ", GetLastError());
              }
           }
         else if(action == "MODIFY")
           {
            long ticket = (long)GetJsonValueDouble(jsonRes, "ticket");
            double sl = GetJsonValueDouble(jsonRes, "sl");
            double tp = GetJsonValueDouble(jsonRes, "tp");
            
            if(ticket > 0 && positionInfo.SelectByTicket(ticket))
              {
               string symbol = positionInfo.Symbol();
               long type = positionInfo.PositionType(); // 0=BUY, 1=SELL
               
               double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
               double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
               double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
               int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
               
               // Safety Zone
               double stopLevel = (double)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
               double freezeLevel = (double)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL) * point;
               double safeDist = MathMax(stopLevel, freezeLevel) + (10 * point);

               double finalSL = sl;
               double finalTP = tp;

               // Validate Stops
               if(type == POSITION_TYPE_BUY)
                 {
                  double maxSL = bid - safeDist;
                  if(finalSL > maxSL) 
                    {
                     Print("MODIFY WARNING: SL ", finalSL, " too close to Bid ", bid, ". Clamping to ", maxSL);
                     finalSL = maxSL;
                    }
                 }
               else if(type == POSITION_TYPE_SELL)
                 {
                  double minSL = ask + safeDist;
                  if(finalSL < minSL)
                    {
                     Print("MODIFY WARNING: SL ", finalSL, " too close to Ask ", ask, ". Clamping to ", minSL);
                     finalSL = minSL;
                    }
                 }
               
               // Normalize
               if(digits > 0)
                 {
                  finalSL = NormalizeDouble(finalSL, digits);
                  finalTP = NormalizeDouble(finalTP, digits);
                 }

               // Check if modification is needed (avoid spamming same values)
               double currentSL = positionInfo.StopLoss();
               double currentTP = positionInfo.TakeProfit();
               
               if(MathAbs(finalSL - currentSL) > point || MathAbs(finalTP - currentTP) > point)
                 {
                  if(trade.PositionModify(ticket, finalSL, finalTP))
                     Print("Position Modified: ", ticket, " SL: ", finalSL, " TP: ", finalTP);
                  else
                     Print("Modify Failed: ", GetLastError());
                 }
              }
           }
        }
     }
  }

//+------------------------------------------------------------------+
//| Simple JSON Helpers (Enhanced)                                   |
//+------------------------------------------------------------------+
string GetJsonValueString(string json, string key)
  {
   // Search for "key":
   int keyPos = StringFind(json, "\"" + key + "\"");
   if(keyPos < 0) return "";
   
   // Find the colon after key
   int colonPos = StringFind(json, ":", keyPos);
   if(colonPos < 0) return "";
   
   // Find value start (first quote)
   int start = StringFind(json, "\"", colonPos + 1);
   if(start < 0) return "";
   
   int end = StringFind(json, "\"", start + 1);
   if(end < 0) return "";
   
   return StringSubstr(json, start + 1, end - start - 1);
  }

double GetJsonValueDouble(string json, string key)
  {
   // Robust double parser for simple JSON structure
   // Handles: "key": 123, "key": 123.45, "key": 0
   
   // Search for "key":
   int keyPos = StringFind(json, "\"" + key + "\"");
   if(keyPos < 0) return 0;
   
   // Find the colon after key
   int colonPos = StringFind(json, ":", keyPos);
   if(colonPos < 0) return 0;
   
   // Start scanning for value after colon
   int start = colonPos + 1;
   
   // Skip whitespace/quotes if any (though usually numbers aren't quoted in our JSON)
   while(start < StringLen(json))
     {
      ushort ch = StringGetCharacter(json, start);
      if(ch != ' ' && ch != '\t' && ch != '\n' && ch != '\"') break;
      start++;
     }
     
   // Find end of value (comma, closing brace, or closing bracket)
   int end = start;
   bool dotFound = false;
   
   while(end < StringLen(json))
     {
      ushort ch = StringGetCharacter(json, end);
      // Allow digits, minus sign, dot, e/E (scientific notation)
      if((ch >= '0' && ch <= '9') || ch == '-' || ch == '.' || ch == 'e' || ch == 'E')
        {
         end++;
        }
      else
        {
         break; // End of number
        }
     }
     
   string val = StringSubstr(json, start, end - start);
   return StringToDouble(val);
  }

long GetJsonValueInt(string json, string key)
  {
   return (long)GetJsonValueDouble(json, key);
  }
