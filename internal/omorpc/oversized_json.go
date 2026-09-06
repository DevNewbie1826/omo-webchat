package omorpc

import (
	"bufio"
	"errors"
)

// oversizedJSON validates one oversized JSONL record while discarding values.
// encoding/json.Decoder (including Token) retains entire strings, so it cannot
// enforce our memory bound. Only envelope metadata is captured here. The depth
// limit matches encoding/json; storage is O(line limit + metadata + depth),
// independent of discarded string length or the number of history entries.
type oversizedJSON struct {
	prefix  []byte
	br      *bufio.Reader
	next    byte
	err     error
	capture []byte
	budget  int
}

func (p *oversizedJSON) advance() {
	if len(p.prefix) > 0 {
		p.next, p.prefix = p.prefix[0], p.prefix[1:]
		return
	}
	p.next, p.err = p.br.ReadByte()
}

func (p *oversizedJSON) fail() {
	if p.err == nil {
		p.err = errors.New("omorpc: invalid or over-depth JSON")
	}
}

func (p *oversizedJSON) take() {
	if p.err != nil {
		return
	}
	if p.next == '\n' {
		p.fail()
		return
	}
	if p.capture != nil {
		if p.budget == 0 {
			p.err = errors.New("omorpc: oversized envelope metadata")
			return
		}
		p.budget--
		p.capture = append(p.capture, p.next)
	}
	p.advance()
}

func (p *oversizedJSON) want(ch byte) {
	if p.next != ch {
		p.fail()
		return
	}
	p.take()
}

func (p *oversizedJSON) space() {
	for p.err == nil && (p.next == ' ' || p.next == '\t' || p.next == '\r') {
		p.take()
	}
}

func (p *oversizedJSON) value(depth int) {
	if p.err != nil {
		return
	}
	switch p.next {
	case '"':
		p.string()
	case '{', '[':
		if depth >= 10000 {
			p.fail()
			return
		}
		object := p.next == '{'
		end := byte(']')
		if object {
			end = '}'
		}
		p.take()
		p.space()
		if p.next == end {
			p.take()
			return
		}
		for p.err == nil {
			if object {
				p.string()
				p.space()
				p.want(':')
				p.space()
			}
			p.value(depth + 1)
			p.space()
			if p.next != ',' {
				p.want(end)
				return
			}
			p.take()
			p.space()
		}
	case 't', 'f', 'n':
		literal := "null"
		if p.next == 't' {
			literal = "true"
		} else if p.next == 'f' {
			literal = "false"
		}
		for i := range len(literal) {
			p.want(literal[i])
		}
	default:
		p.number()
	}
}

func (p *oversizedJSON) string() {
	p.want('"')
	for p.err == nil {
		switch {
		case p.next == '"':
			p.take()
			return
		case p.next < 0x20:
			p.fail()
			return
		case p.next == '\\':
			p.take()
			switch p.next {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
				p.take()
			case 'u':
				p.take()
				for range 4 {
					ch := p.next
					if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f' || ch >= 'A' && ch <= 'F') {
						p.fail()
						return
					}
					p.take()
				}
			default:
				p.fail()
				return
			}
		default:
			p.take()
		}
	}
}

func (p *oversizedJSON) digits() {
	if p.next < '0' || p.next > '9' {
		p.fail()
		return
	}
	for p.err == nil && p.next >= '0' && p.next <= '9' {
		p.take()
	}
}

func (p *oversizedJSON) number() {
	if p.next == '-' {
		p.take()
	}
	if p.next == '0' {
		p.take()
	} else {
		p.digits()
	}
	if p.next == '.' {
		p.take()
		p.digits()
	}
	if p.next == 'e' || p.next == 'E' {
		p.take()
		if p.next == '+' || p.next == '-' {
			p.take()
		}
		p.digits()
	}
}
