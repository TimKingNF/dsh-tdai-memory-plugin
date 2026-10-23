#!/usr/bin/env python3
"""ds-bot 会话时序探针：用历史会话日志验证「按人锚点写回合」方案的时序假设。

只读：不写 ~/.dsh/bot，不调任何接口。输出人读报告，可选 --json 落机读结果。

回答六个问题：
  Q1 写入钩子：一轮的事件序列是什么？turn-stopping 是否总在最后一个 assistant
     step 之后、turn/end 之前？收尾步是否一定带 text（「取最后一 step」的前提）？
  Q2 失败轮规模：turn/end 的 reason 分布；有多少轮走不到 turn-stopping
     （宿主只在成功路径派发该事件）。
  Q3 群聊锚点：真人消息这一行，是否在 room root 会话的轮末之前就已进入
     room log / 已投递给成员（决定「轮末定位」能不能找到它）。
  Q4 锚点可定位性：真人原话能否在 room log 里按文本命中；重复文本有多少。
  Q5 长度：真人消息超过 TEXT_KEPT(2000) 的有几条；group-lines/ 全文存档是否在。
  Q6 环与 seq：room log 行数、seq 范围、是否已被环形覆盖 / 重排。

用法：
  python3 scripts/dsbot-timing-probe.py            # 报告
  python3 scripts/dsbot-timing-probe.py --json out.json
  python3 scripts/dsbot-timing-probe.py --rooms 2  # 只详查最近 2 个房间
"""
import argparse
import glob
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict

HOME = os.environ.get('DSH_HOME', '').strip() or os.path.expanduser('~/.dsh')
BOT = os.path.join(HOME, 'bot')
SESSIONS = os.path.join(HOME, 'sessions')
TEXT_KEPT = 2000  # ds-bot src/host/constants.js


def load_state():
    path = os.path.join(BOT, 'state.json')
    if not os.path.exists(path):
        sys.exit('找不到 %s' % path)
    with open(path, encoding='utf-8') as f:
        return json.load(f), path


def session_path(sid):
    hits = glob.glob(os.path.join(SESSIONS, '*', sid, 'session.v4.jsonl.zstd'))
    return hits[0] if hits else None


def read_events(path):
    if not path:
        return []
    out = subprocess.run(['zstd', '-dc', path], capture_output=True)
    if out.returncode != 0:
        return []
    events = []
    for line in out.stdout.decode('utf-8', 'replace').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def source_of(event):
    data = event.get('data') or {}
    for msg in (data.get('message'), data):
        if isinstance(msg, dict) and isinstance(msg.get('source'), dict):
            return msg['source']
    return {}


def content_of(event):
    data = event.get('data') or {}
    for msg in (data.get('message'), data):
        if isinstance(msg, dict) and isinstance(msg.get('content'), list):
            return msg['content']
    return []


def text_of(event):
    return ''.join(
        block.get('text', '')
        for block in content_of(event)
        if isinstance(block, dict) and block.get('type') == 'text'
    )


def blocks_of(event):
    return [block.get('type') for block in content_of(event) if isinstance(block, dict)]


def analyse_session(path):
    """返回 (turns, humans)

    turns: turn -> {steps, by_step: {step: [block types]}, reason, end}
    humans: [{time, text, before_turn, after_turn}]，真人消息常落在两轮之间，
            因此记录它之前最近的一轮与之后最近的一轮。
    """
    turns = defaultdict(lambda: {'steps': 0, 'by_step': {}, 'reason': None, 'start': None, 'end': None})
    humans = []
    turn_order = []
    for event in read_events(path):
        etype = event.get('type')
        data = event.get('data') or {}
        turn = data.get('turn')
        time = event.get('time')
        if etype == 'turn/start':
            slot = turns[turn]
            slot['start'] = time
            turn_order.append((time, turn))
        elif etype == 'step/start':
            turns[turn]['steps'] += 1
            turns[turn]['by_step'].setdefault(data.get('step'), [])
        elif etype == 'assistant/message':
            step = data.get('step')
            turns[turn]['by_step'].setdefault(step, [])
            turns[turn]['by_step'][step] = blocks_of(event) or turns[turn]['by_step'][step]
        elif etype == 'turn/end':
            turns[turn]['reason'] = (data.get('reason') or {}).get('kind')
            turns[turn]['end'] = time
        elif etype == 'user/message':
            if source_of(event).get('kind') == 'user':
                humans.append({'time': time, 'turn': turn, 'text': text_of(event)})
    # 真人消息归属：实测它们总落在「已打开的一轮」之内（事件本身不带 turn 字段），
    # 因此归属轮 = 消息时刻之前最近一个尚未结束的 turn。
    for human in humans:
        enclosing = None
        for ts, turn in turn_order:
            if ts is not None and human['time'] is not None and ts <= human['time']:
                slot = turns[turn]
                if slot['end'] is None or slot['end'] >= human['time']:
                    enclosing = turn
        human['next_turn'] = enclosing
    return turns, humans


def last_step_blocks(slot):
    if not slot['by_step']:
        return []
    return slot['by_step'][max(slot['by_step'])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', default=None)
    ap.add_argument('--rooms', type=int, default=3, help='详查最近 N 个房间')
    args = ap.parse_args()

    state, state_path = load_state()
    rooms = state.get('rooms') or {}
    bots = state.get('bots') or {}
    print('state.json: %s (version=%s, bots=%d, rooms=%d)' % (state_path, state.get('version'), len(bots), len(rooms)))

    role = {}
    for rid, room in rooms.items():
        role[rid] = 'room-root'
        for bid, sid in (room.get('sessions') or {}).items():
            role[sid] = 'room-member'
        for bid, segs in (room.get('segments') or {}).items():
            for seg in segs or []:
                if isinstance(seg, dict) and seg.get('sessionId'):
                    role[seg['sessionId']] = 'room-member'
    for bid, bot in bots.items():
        role[bid] = role.get(bid, 'bot-dm')
        current = bot.get('sessionId') or bid
        role[current] = 'bot-dm'
        for seg in bot.get('segments') or []:
            if isinstance(seg, dict) and seg.get('sessionId'):
                role[seg['sessionId']] = 'bot-dm'

    report = {'state': state_path, 'sessions': {}, 'q': {}}

    # ---------- Q1 / Q2 ----------
    # 必须按会话角色拆开：room root 的每一轮是 group_relay 工具调用，天然没有文本，
    # 混在一起统计会把「群聊轮没有终稿」误读成「DM 终稿规则失效」。
    by_role = defaultdict(lambda: {'completed': 0, 'no_text': 0, 'last_blocks': Counter(), 'reasons': Counter()})
    reason_by_last = Counter()
    reason_counter = Counter()
    all_turns = 0
    for sid, kind in sorted(role.items()):
        path = session_path(sid)
        if not path:
            continue
        turns, humans = analyse_session(path)
        all_turns += len(turns)
        for turn, slot in turns.items():
            reason = slot['reason']
            reason_counter[reason] += 1
            last = last_step_blocks(slot)
            reason_by_last[(reason, '+'.join(last) or '(none)')] += 1
            bucket = by_role[kind]
            bucket['reasons'][reason] += 1
            bucket['last_blocks']['+'.join(last) or '(none)'] += 1
            if reason == 'completed':
                bucket['completed'] += 1
                if 'text' not in last:
                    bucket['no_text'] += 1
        report['sessions'][sid] = {
            'role': kind,
            'turns': len(turns),
            'humans': len(humans),
            'failed_turns': sum(1 for t in turns.values() if t['reason'] not in (None, 'completed')),
        }

    print('\n== Q1/Q2 轮结构与失败轮')
    print('会话数：%d，轮数：%d' % (len(report['sessions']), all_turns))
    print('turn/end reason 分布：%s' % dict(reason_counter))
    print('按角色的 completed 轮：收尾步是否带 text')
    for kind, bucket in sorted(by_role.items()):
        completed = bucket['completed']
        print('   %-12s completed=%-4d 收尾步无 text=%-4d (%.0f%%)  top blocks=%s'
              % (kind, completed, bucket['no_text'],
                 100.0 * bucket['no_text'] / completed if completed else 0,
                 bucket['last_blocks'].most_common(3)))
    print('收尾步（最后一个 step）的 block 组合 × reason（top8）：')
    for (reason, blocks), count in reason_by_last.most_common(8):
        print('   reason=%-10s last-step=%-24s %d' % (reason, blocks, count))
    report['q']['turn_end_reason'] = dict(reason_counter)
    report['q']['by_role'] = {
        kind: {'completed': b['completed'], 'no_text': b['no_text'],
               'last_blocks': dict(b['last_blocks']), 'reasons': dict(b['reasons'])}
        for kind, b in by_role.items()
    }

    # ---------- Q3：群聊锚点的时机 ----------
    # 口径：真人原话若在该轮轮末之前已出现在成员会话的投递文本里，说明 ds-bot
    # 在轮内就已 appendRoom（appendRoom 先于 callMembers），则「轮末定位」可行。
    room_rows = []
    for rid in list(rooms)[: args.rooms]:
        root = session_path(rid)
        if not root:
            continue
        turns, humans = analyse_session(root)
        deliveries = []
        for bid, sid in (rooms[rid].get('sessions') or {}).items():
            for event in read_events(session_path(sid)):
                if event.get('type') == 'user/message' and source_of(event).get('kind') != 'user':
                    deliveries.append((event.get('time') or 0, text_of(event)))
        for human in humans:
            needle = human['text'].strip()[:30]
            if not needle:
                continue
            first = min((t for t, txt in deliveries if needle in txt), default=None)
            # 该消息触发的那一轮（之后最近开始的一轮）的轮末
            nxt = human.get('next_turn')
            end = turns[nxt]['end'] if nxt in turns else None
            room_rows.append({
                'room': rid, 'turn': nxt, 'len': len(human['text']),
                'turn_end': end, 'first_delivery': first,
                'before_turn_end': (first is not None and end is not None and first <= end),
                'delta_s': None if (first is None or end is None) else round((first - end) / 1000.0, 1),
                'text': human['text'][:26],
            })
    print('\n== Q3 群聊真人锚点：是否在触发轮的轮末之前已投递给成员')
    if not room_rows:
        print('   样本为空')
    for row in room_rows[:14]:
        print('   turn=%-3s len=%-4d delivery-turnend=%+8ss before=%s  %r'
              % (row['turn'], row['len'], row['delta_s'], row['before_turn_end'], row['text']))
    report['q']['room_anchor_timing'] = room_rows

    # ---------- Q4/Q5 ----------
    locatable = Counter()
    over_kept = 0
    total_humans = 0
    lengths = []
    for rid, room in rooms.items():
        log = room.get('log') or []
        user_lines = [line for line in log if line.get('who') == 'User']
        root = session_path(rid)
        if not root:
            continue
        _, humans = analyse_session(root)
        for human in humans:
            total_humans += 1
            lengths.append(len(human['text']))
            if len(human['text']) > TEXT_KEPT:
                over_kept += 1
            needle = human['text'].strip()[:40]
            hits = sum(1 for line in user_lines if needle and needle in (line.get('text') or ''))
            locatable['hit' if hits else 'miss'] += 1
            if hits:
                locatable['duplicate' if hits > 1 else 'unique'] += 1
        print('   房间 %s… log=%d 行 seq=%s..%s User行=%d'
              % (rid[:18], len(log), (log[0].get('seq') if log else None),
                 (log[-1].get('seq') if log else None), len(user_lines)))
    print('   真人消息 %d 条，长度中位 %s，>TEXT_KEPT 的 %d 条'
          % (total_humans, sorted(lengths)[len(lengths) // 2] if lengths else '-', over_kept))
    print('   在 room log 里按前 40 字符定位：%s' % dict(locatable))
    gdir = os.path.join(BOT, 'group-lines')
    gfiles = glob.glob(os.path.join(gdir, '*', '*.txt'))
    print('   group-lines 全文存档：%d 个文件' % len(gfiles))

    # ---------- Q6 ----------
    print('\n== Q6 room log 环与 seq')
    ring = []
    for rid, room in rooms.items():
        log = room.get('log') or []
        seqs = [line.get('seq') for line in log if line.get('seq') is not None]
        truncated = sum(1 for line in log if line.get('length') is not None)
        ring.append({'room': rid, 'lines': len(log),
                     'seq_min': min(seqs) if seqs else None,
                     'seq_max': max(seqs) if seqs else None,
                     'room_seq': room.get('seq'), 'truncated': truncated})
        print('   %s… 行=%2d seq=%s..%s room.seq=%s 截断行=%d'
              % (rid[:18], len(log), min(seqs) if seqs else '-', max(seqs) if seqs else '-',
                 room.get('seq'), truncated))

    report['q'].update({
        'human_total': total_humans, 'human_over_text_kept': over_kept,
        'locatable': dict(locatable), 'group_line_files': len(gfiles), 'rooms': ring,
    })
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print('\nJSON → %s' % args.json)


if __name__ == '__main__':
    main()
