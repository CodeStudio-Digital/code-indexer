pub fn string_field<'a>(bytes: &'a [u8], name: &str) -> Option<&'a str> {
    let value = top_level_field(bytes, name)?;
    if value.len() < 2 || value.first() != Some(&b'"') || value.last() != Some(&b'"') {
        return None;
    }
    let inner = &value[1..value.len() - 1];
    if inner.contains(&b'\\') {
        return None;
    }
    std::str::from_utf8(inner).ok()
}

pub fn u64_field(bytes: &[u8], name: &str) -> Option<u64> {
    std::str::from_utf8(top_level_field(bytes, name)?)
        .ok()?
        .parse()
        .ok()
}

fn top_level_field<'a>(bytes: &'a [u8], name: &str) -> Option<&'a [u8]> {
    let mut index = skip_space(bytes, 0);
    if bytes.get(index) != Some(&b'{') {
        return None;
    }
    index += 1;
    let mut found = None;
    loop {
        index = skip_space(bytes, index);
        if bytes.get(index) == Some(&b'}') {
            return found;
        }
        let (key, after_key) = parse_string(bytes, index)?;
        index = skip_space(bytes, after_key);
        if bytes.get(index) != Some(&b':') {
            return None;
        }
        index = skip_space(bytes, index + 1);
        let end = value_end(bytes, index)?;
        if key == name.as_bytes() {
            if found.is_some() {
                return None;
            }
            found = Some(&bytes[index..end]);
        }
        index = skip_space(bytes, end);
        match bytes.get(index) {
            Some(b',') => index += 1,
            Some(b'}') => return found,
            _ => return None,
        }
    }
}

fn value_end(bytes: &[u8], start: usize) -> Option<usize> {
    match bytes.get(start)? {
        b'"' => parse_string(bytes, start).map(|(_, end)| end),
        b'{' | b'[' => nested_end(bytes, start),
        _ => {
            let end = bytes[start..]
                .iter()
                .position(|byte| matches!(byte, b',' | b'}'))
                .map_or(bytes.len(), |offset| start + offset);
            let trimmed = trim_space_end(bytes, start, end);
            (trimmed > start).then_some(trimmed)
        }
    }
}

fn nested_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start;
    let mut stack = Vec::with_capacity(8);
    while let Some(byte) = bytes.get(index) {
        match byte {
            b'"' => index = parse_string(bytes, index)?.1,
            b'{' => {
                stack.push(b'}');
                index += 1;
            }
            b'[' => {
                stack.push(b']');
                index += 1;
            }
            b'}' | b']' if stack.pop() == Some(*byte) => {
                index += 1;
                if stack.is_empty() {
                    return Some(index);
                }
            }
            b'}' | b']' => return None,
            _ => index += 1,
        }
    }
    None
}

fn parse_string(bytes: &[u8], start: usize) -> Option<(&[u8], usize)> {
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut index = start + 1;
    let mut escaped = false;
    while let Some(byte) = bytes.get(index) {
        if escaped {
            escaped = false;
        } else if *byte == b'\\' {
            escaped = true;
        } else if *byte == b'"' {
            return Some((&bytes[start + 1..index], index + 1));
        } else if byte.is_ascii_control() {
            return None;
        }
        index += 1;
    }
    None
}

fn skip_space(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

fn trim_space_end(bytes: &[u8], start: usize, mut end: usize) -> usize {
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    end
}
