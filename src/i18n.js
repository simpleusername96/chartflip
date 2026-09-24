/* Chartflip text: Korean and English. Kept short on purpose: the game explains itself by play. */
(function (CF) {
  'use strict';

  const TEXT = {
    ko: {
      tagline: '바닥에서 뒤집어라.',
      tutorial: '튜토리얼',
      noRecord: '기록 없음',
      goldTarget: seconds => `금 ${seconds}초`,
      tapToStart: '탭해서 출발',
      keyToStart: '스페이스로 출발',
      flip: '뒤집기',
      boost: '부스트',
      hold: '꾹',
      crawlHint: '탭! 뒤집으면 내리막',
      perfect: 'PERFECT',
      good: 'GOOD',
      clean: 'CLEAN',
      ouch: '쿵!',
      office: '회사',
      finishGate: '퇴근',
      ghost: '내 기록',
      paused: '일시정지',
      resume: '계속하기',
      restart: '처음부터',
      courses: '코스',
      retry: '다시',
      next: '다음',
      newBest: '신기록!',
      vsBest: delta => `최고 기록 ${delta}`,
      toMedal: (medal, seconds) => `${['금', '은', '동'][medal]}메달까지 ${seconds}초`,
      verdict: ['칼퇴 성공!', '무난한 퇴근', '겨우 퇴근', '야근 확정…'],
      medal: ['금메달', '은메달', '동메달', '메달 없음'],
      copy: '기록 복사',
      copied: '기록을 복사했어요',
      copyFailed: '복사할 수 없어요',
      language: 'EN',
      storageFailed: '기록을 브라우저에 저장하지 못했습니다.',
      languageName: 'English',
      soundOn: '소리 켜짐',
      soundOff: '소리 꺼짐',
      help: '플레이 방법',
      close: '확인',
      helpSteps: [
        ['바닥에서 뒤집기', '탭하면 차트가 뒤집혀요. 바닥에서 뒤집으면 오르막이 내리막이 돼요.'],
        ['코인 = 부스트 연료', '코인을 먹으면 오른쪽 아래 게이지가 차요. 가득 차면 더 못 담아요.'],
        ['꾹 눌러 부스트', '길게 누를수록 강해져요. 공중에서도 날아가는 방향으로 가속해요.']
      ],
      keys: '스페이스 뒤집기 · X 꾹 부스트 · R 다시 · Esc 일시정지',
      seconds: '초',
      canvas: '차트플립 게임 화면',
      shareLine: (name, time, medal) => `CHARTFLIP ${name} ${time}초${medal}`,
      back: '코스 목록으로',
      pause: '일시정지',
      sound: '소리 켜기/끄기',
      boostButton: '부스트 (누르고 있기)',
      coins: '코인',
      full: '가득!'
    },
    en: {
      tagline: 'Flip at the bottom.',
      tutorial: 'Tutorial',
      noRecord: 'No record',
      goldTarget: seconds => `Gold ${seconds}s`,
      tapToStart: 'Tap to start',
      keyToStart: 'Press Space to start',
      flip: 'Flip',
      boost: 'Boost',
      hold: 'hold',
      crawlHint: 'Tap! Flip it into a slide',
      perfect: 'PERFECT',
      good: 'GOOD',
      clean: 'CLEAN',
      ouch: 'OOF',
      office: 'OFFICE',
      finishGate: 'HOME',
      ghost: 'BEST',
      paused: 'Paused',
      resume: 'Resume',
      restart: 'Restart',
      courses: 'Courses',
      retry: 'Retry',
      next: 'Next',
      newBest: 'New best!',
      vsBest: delta => `${delta} vs best`,
      toMedal: (medal, seconds) => `${seconds}s to ${['gold', 'silver', 'bronze'][medal]}`,
      verdict: ['Clocked out on time!', 'Smooth commute', 'Made it home', 'Overtime…'],
      medal: ['Gold', 'Silver', 'Bronze', 'No medal'],
      copy: 'Copy result',
      copied: 'Result copied',
      copyFailed: 'Could not copy',
      language: 'KR',
      storageFailed: 'Could not save records in this browser.',
      languageName: '한국어',
      soundOn: 'Sound on',
      soundOff: 'Sound off',
      help: 'How to play',
      close: 'Got it',
      helpSteps: [
        ['Flip at the bottom', 'A tap flips the chart. Flip at a bottom and the climb ahead becomes a slide.'],
        ['Coins fuel the boost', 'Coins fill the gauge at the bottom right. A full gauge takes no more.'],
        ['Hold to boost', 'Hold longer for more power. In the air, boost along your flight path.']
      ],
      keys: 'Space flip · hold X boost · R retry · Esc pause',
      seconds: 's',
      canvas: 'Chartflip game view',
      shareLine: (name, time, medal) => `CHARTFLIP ${name} ${time}s${medal}`,
      back: 'Back to courses',
      pause: 'Pause',
      sound: 'Toggle sound',
      boostButton: 'Boost (hold)',
      coins: 'Coins',
      full: 'FULL!'
    }
  };

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '--.--';
    // Round to hundredths first, so 59.996 s reads 1:00.00 rather than 60.00.
    const hundredths = Math.round(seconds * 100);
    const minutes = Math.floor(hundredths / 6000);
    const rest = ((hundredths - minutes * 6000) / 100).toFixed(2).padStart(5, '0');
    return minutes ? `${minutes}:${rest}` : rest;
  }

  function pickLanguage(stored) {
    if (stored === 'ko' || stored === 'en') return stored;
    const browser = (globalThis.navigator && navigator.language) || 'ko';
    return browser.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  }

  CF.i18n = { TEXT, formatTime, pickLanguage };
})(globalThis.Chartflip = globalThis.Chartflip || {});
