/* Chartflip courses: fictional charts authored for the game from classic chart-pattern ideas.
 * Each pattern is a list of turning levels (0..1000); `level:days` stretches a leg in time.
 * The candles between turns are deterministic noise for decoration. No market data ships. */
(function (CF) {
  'use strict';

  /** Deterministic 0..1 noise from a seed (small LCG). */
  function noise(seed) {
    let state = (seed * 2654435761) >>> 0 || 1;
    return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  }

  /**
   * Daily values from turning levels. A leg lasts `days` samples (default grows with its size);
   * candles wobble inside the leg but never reverse enough to add a turn of their own.
   */
  function chart(pattern, seed) {
    const random = noise(seed);
    const turns = pattern.trim().split(/\s+/).map(token => {
      const [level, days] = token.split(':').map(Number);
      return { level, days };
    });
    const values = [turns[0].level];
    for (let index = 1; index < turns.length; index++) {
      const from = turns[index - 1].level;
      const { level: to, days = Math.round(9 + Math.abs(to - from) / 45) } = turns[index];
      const weights = Array.from({ length: days }, () => 1 + 1.9 * (random() - 0.4));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let value = from;
      for (let day = 0; day < days; day++) {
        value += (to - from) * weights[day] / total;
        values.push(Math.round(Math.max(0, Math.min(1000, day === days - 1 ? to : value))));
      }
    }
    return values;
  }

  // Id, names, captions, turning levels, time scale (world units per day).
  const tracks = [
    ['double-bottom', '쌍바닥', 'Double Bottom', '두 번 찍으면 바닥이다.', 'Hit the floor twice, then fly.',
      '760 140 560 160 900 470 800', 40],
    ['dead-cat', '데드캣 바운스', 'Dead Cat Bounce', '반등인 줄 알았지?', 'Thought it was a rebound?',
      '860 700 900 250:6 440 120:6 300 90:6', 66],
    ['cup-handle', '컵앤핸들', 'Cup and Handle', '커피 한 잔 하고 돌파.', 'A coffee break, then a breakout.',
      '880 560 640 250 330 210 700 560 980', 60],
    ['staircase', '계단식 상승', 'Staircase', '두 칸 오르고 한 칸 쉬고.', 'Two steps up, one step back.',
      '60 380 290 540 470 700 560 860 780 990 620', 66],
    ['head-shoulders', '헤드앤숄더', 'Head & Shoulders', '머리 찍고 어깨에서 내린다.', 'Over the head, off at the shoulder.',
      '150 560 380 920 370 600 360 430 80:6 240', 57],
    ['range-bound', '박스권', 'Range Bound', '위도 막히고 아래도 막혔다.', 'Capped above, floored below.',
      '500 700 320 680 300 720 340 660 280 700 330 690 520', 57],
    ['v-recovery', 'V자 반등', 'V Recovery', '떨어진 만큼 빠르게 돌아온다.', 'Down fast, back faster.',
      '900 760 820 640 700 480 540 90:6 420:8 360 640 580 860 800', 62],
    ['short-squeeze', '숏스퀴즈', 'Short Squeeze', '조용하다 싶더니 폭발.', 'Quiet, quiet… then boom.',
      '260 340:12 220:12 350:12 210:12 330:12 180:12 1000:12 360:7 640 200:7 380', 40],
    ['averaging-down', '물타기', 'Averaging Down', '평단도 내려가고 차트도 내려간다.', 'The average drops. So does the chart.',
      '950 700 820 560 700 430 580 330 460 240 380 160 300 60 200 140', 61],
    ['circuit-breaker', '서킷브레이커', 'Circuit Breaker', '잠깐 멈춤. 그리고 또 낙하.', 'Trading halted. Then down again.',
      '600 780 560 740 520 700 150:8 220:26 160:26 600 380 560 60:8 130:26 70:26 480 420 700', 43],
    ['bubble', '버블', 'Bubble', '오를수록 가팔라진다.', 'The higher it goes, the steeper it gets.',
      '100 180:16 140 230:16 180 300:14 240 390:12 320 520:10 430 700:8 590 1000:7 380:7 560 250 400 120 200', 28],
    ['to-the-moon', '가즈아', 'To the Moon', '멈추지 않는 우상향.', 'Up and to the right. Keep going.',
      '80 260 180 340 260 420 330 500 150 560 470 640 560 720 620 780 700 860 760 900 820 960 880 1000 700', 52],
    ['whipsaw', '휩쏘', 'Whipsaw', '올라? 내려? 둘 다.', 'Up? Down? Both.',
      '500 620 280 820 700 760 240 300 180 900 400 480 350 780 120 260 200 840 600 700 300 500', 29],
    ['closing-bell', '장 마감', 'Closing Bell', '오늘의 모든 차트를 지나 퇴근.', 'Every chart of the day, then home.',
      '500 620 450 640 380 470 150:6 330 200 700 560 820 640 1000:10 300:7 480 240 520 460 560 420 480 60:6 380 300 620 540 760 680 900 820', 33]
  ];

  const medalTimes = {
      "practice": [
          11.1,
          12.5,
          15
      ],
      "double-bottom": [
          10,
          11.5,
          13.5
      ],
      "dead-cat": [
          12.5,
          13,
          16
      ],
      "cup-handle": [
          13.6,
          15,
          18
      ],
      "staircase": [
          13.9,
          16,
          20
      ],
      "head-shoulders": [
          16.1,
          17.5,
          20
      ],
      "range-bound": [
          16.4,
          19,
          23
      ],
      "v-recovery": [
          17.8,
          20.5,
          25
      ],
      "short-squeeze": [
          20,
          22.5,
          27
      ],
      "averaging-down": [
          21,
          24,
          30
      ],
      "circuit-breaker": [
          22.9,
          27,
          33
      ],
      "bubble": [
          24.3,
          28,
          37
      ],
      "to-the-moon": [
          26.5,
          31,
          41
      ],
      "whipsaw": [
          29,
          34,
          42
      ],
      "closing-bell": [
          31.7,
          37,
          55
      ]
  };

  CF.courses = [{
    id: 'practice',
    kind: 'authored',
    name: { ko: '모의투자', en: 'Paper Trading' },
    caption: { ko: '바닥에서 뒤집으면 오르막도 내리막.', en: 'Flip at the bottom and every climb becomes a slide.' },
    guide: true,
    medals: medalTimes.practice,
    points: [[0, 0], [1600, -250], [3300, 350], [5000, -150], [6900, 550], [8800, 100], [10700, 650], [12800, 0]],
    signs: [
      { x: 1000, text: { ko: '바닥에서 탭!', en: 'Tap at the bottom!' } },
      { x: 2450, text: { ko: '바닥마다 뒤집기', en: 'Flip at every bottom' } },
      { x: 4150, text: { ko: '코인 = 부스트 연료', en: 'Coins fuel the boost' } },
      { x: 5950, text: { ko: '땅에서 꾹! 부스트', en: 'Hold boost on the ground!' } }
    ]
  }, ...tracks.map(([id, ko, en, koCaption, enCaption, pattern, perDay], index) => ({
    id,
    kind: 'chart',
    name: { ko, en },
    caption: { ko: koCaption, en: enCaption },
    values: chart(pattern, index + 1),
    swing: 0.04,
    leg: 460,
    stretch: 2,
    perDay,
    minRun: 1100,
    medals: medalTimes[id]
  }))];
})(globalThis.Chartflip = globalThis.Chartflip || {});
