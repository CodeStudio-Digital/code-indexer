const Database = require('better-sqlite3');

const dbPath = process.argv[1];

try {
  const db = new Database(dbPath, { readonly: true });
  
  // Query 1: Tool calls savings aggregation
  const savings = db.prepare(`
    SELECT
      COALESCE(SUM(output_chars), 0) as total_raw_chars,
      COALESCE(SUM(COALESCE(output_chars_shaped, output_chars)), 0) as total_shaped_chars,
      COUNT(*) as tool_call_count,
      COALESCE(SUM(truncated), 0) as truncated_count
    FROM coder_tool_calls
  `).get();
  
  console.log('=== TOOL CALLS SAVINGS ===');
  console.log('Total raw chars:', savings.total_raw_chars);
  console.log('Total shaped chars:', savings.total_shaped_chars);
  console.log('Saved chars:', Math.max(0, savings.total_raw_chars - savings.total_shaped_chars));
  console.log('Estimated saved tokens (~4 chars/token):', Math.round(Math.max(0, savings.total_raw_chars - savings.total_shaped_chars) / 4));
  console.log('Tool calls truncated:', savings.truncated_count);
  console.log('Total tool calls:', savings.tool_call_count);
  console.log('Truncation rate:', (savings.truncated_count / savings.tool_call_count * 100).toFixed(2) + '%');
  
  // Query 2: Cache hits
  const cache = db.prepare(`
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input,
      COALESCE(SUM(total_cache_read_tokens), 0) as cache_read,
      COALESCE(SUM(total_cache_creation_tokens), 0) as cache_creation
    FROM coder_sessions
  `).get();
  
  console.log('\n=== CACHE TOKENS ===');
  console.log('Total input tokens:', cache.total_input);
  console.log('Total cache read tokens:', cache.cache_read);
  console.log('Cache hit ratio:', cache.total_input > 0 ? (cache.cache_read / cache.total_input * 100).toFixed(2) + '%' : 'N/A');
  console.log('Cache creation tokens:', cache.cache_creation);
  
  // Query 3: Distribution
  const dist = db.prepare(`
    SELECT
      SUM(CASE WHEN output_chars > 24000 THEN 1 ELSE 0 END) as over_24k,
      SUM(CASE WHEN output_chars > 16000 AND output_chars <= 24000 THEN 1 ELSE 0 END) as between_16k_24k,
      SUM(CASE WHEN output_chars > 8000 AND output_chars <= 16000 THEN 1 ELSE 0 END) as between_8k_16k,
      COUNT(*) as total,
      MAX(output_chars) as largest_result
    FROM coder_tool_calls
  `).get();
  
  console.log('\n=== OUTPUT SIZE DISTRIBUTION ===');
  console.log('Tool results > 24k chars:', dist.over_24k);
  console.log('Tool results 16k-24k chars:', dist.between_16k_24k);
  console.log('Tool results 8k-16k chars:', dist.between_8k_16k);
  console.log('Largest single result:', dist.largest_result, 'chars');
  
  // Query 4: Most recent session
  const recent = db.prepare(`
    SELECT
      s.id,
      COALESCE(SUM(tc.output_chars), 0) as total_output_chars,
      COALESCE(SUM(COALESCE(tc.output_chars_shaped, tc.output_chars)), 0) as total_shaped_chars,
      COUNT(tc.id) as tool_calls,
      COALESCE(SUM(s.total_input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(s.total_cache_read_tokens), 0) as total_cache_read
    FROM coder_sessions s
    LEFT JOIN coder_messages m ON m.session_id = s.id
    LEFT JOIN coder_tool_calls tc ON tc.message_id = m.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT 1
  `).get();
  
  if (recent) {
    console.log('\n=== MOST RECENT SESSION (ID: ' + recent.id + ') ===');
    console.log('Tool calls:', recent.tool_calls);
    console.log('Raw output chars:', recent.total_output_chars);
    console.log('Shaped output chars:', recent.total_shaped_chars);
    console.log('Saved chars:', Math.max(0, recent.total_output_chars - recent.total_shaped_chars));
    console.log('Saved tokens est:', Math.round(Math.max(0, recent.total_output_chars - recent.total_shaped_chars) / 4));
    console.log('Total input tokens:', recent.total_input_tokens);
    console.log('Cache read tokens:', recent.total_cache_read);
    if (recent.total_input_tokens > 0) {
      console.log('Cache hit ratio:', (recent.total_cache_read / recent.total_input_tokens * 100).toFixed(2) + '%');
    }
  }
  
  db.close();
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
