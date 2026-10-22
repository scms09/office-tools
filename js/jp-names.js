/*
 * English names for common Japanese railway lines and stations. NAVITIME's free
 * plan only returns Japanese names; anything not listed here stays in Japanese.
 * Add entries as needed — longer names are matched first.
 */
const JpNames = (function () {
  const WORDS = {
    // Operators
    'JR東日本': 'JR East ', 'JR東海': 'JR Central ', 'JR': 'JR ', '東京メトロ': 'Tokyo Metro ', '都営': 'Toei ',
    '東武': 'Tobu ', '西武': 'Seibu ', '京急': 'Keikyu ', '京成': 'Keisei ', '小田急': 'Odakyu ', '京王': 'Keio ',
    '東急': 'Tokyu ', '相鉄': 'Sotetsu ', '東京モノレール': 'Tokyo Monorail', 'りんかい線': 'Rinkai Line',
    'つくばエクスプレス': 'Tsukuba Express', 'ゆりかもめ': 'Yurikamome', '埼玉高速鉄道': 'Saitama Railway',
    '遠州鉄道': 'Enshu Railway', '天竜浜名湖鉄道': 'Tenryu-Hamanako Railway',
    // Shinkansen and limited expresses
    '東海道新幹線': 'Tokaido Shinkansen', '東北新幹線': 'Tohoku Shinkansen', '上越新幹線': 'Joetsu Shinkansen',
    '北陸新幹線': 'Hokuriku Shinkansen', '新幹線': 'Shinkansen', 'のぞみ': 'Nozomi', 'ひかり': 'Hikari', 'こだま': 'Kodama',
    'やまびこ': 'Yamabiko', 'なすの': 'Nasuno', 'はやぶさ': 'Hayabusa', 'とき': 'Toki', 'かがやき': 'Kagayaki', 'あさま': 'Asama',
    '成田エクスプレス': 'Narita Express', 'スカイライナー': 'Skyliner', 'アクセス特急': 'Access Express',
    // Lines
    '山手線': 'Yamanote Line', '京浜東北線': 'Keihin-Tohoku Line', '根岸線': 'Negishi Line', '中央線': 'Chuo Line',
    '中央・総武線': 'Chuo-Sobu Line', '総武線': 'Sobu Line', '埼京線': 'Saikyo Line', '川越線': 'Kawagoe Line',
    '湘南新宿ライン': 'Shonan-Shinjuku Line', '上野東京ライン': 'Ueno-Tokyo Line', '高崎線': 'Takasaki Line',
    '宇都宮線': 'Utsunomiya Line', '東海道線': 'Tokaido Line', '東海道本線': 'Tokaido Main Line', '横須賀線': 'Yokosuka Line',
    '武蔵野線': 'Musashino Line', '京葉線': 'Keiyo Line', '常磐線': 'Joban Line', '日光線': 'Nikko Line', '両毛線': 'Ryomo Line',
    '東上線': 'Tojo Line', '東上本線': 'Tojo Main Line', '池袋線': 'Ikebukuro Line', '新宿線': 'Shinjuku Line',
    '伊勢崎線': 'Isesaki Line', 'スカイツリーライン': 'Skytree Line', '空港線': 'Airport Line', '本線': 'Main Line',
    '銀座線': 'Ginza Line', '丸ノ内線': 'Marunouchi Line', '日比谷線': 'Hibiya Line', '東西線': 'Tozai Line',
    '千代田線': 'Chiyoda Line', '有楽町線': 'Yurakucho Line', '半蔵門線': 'Hanzomon Line', '南北線': 'Namboku Line',
    '副都心線': 'Fukutoshin Line', '浅草線': 'Asakusa Line', '三田線': 'Mita Line', '大江戸線': 'Oedo Line',
    '東葉高速線': 'Toyo Rapid Line',
    // Train types
    '空港快速': ' Airport Rapid', '区間快速': ' Section Rapid', '通勤快速': ' Commuter Rapid', '快速急行': ' Rapid Express',
    '通勤急行': ' Commuter Express', '特急': ' Limited Express', '急行': ' Express', '快速': ' Rapid', '準急': ' Semi-Express',
    '各駅停車': ' Local', '普通': ' Local', '徒歩': 'Walk', '・': ' / ',
    // Stations and places
    '羽田空港第1・第2ターミナル': 'Haneda Airport T1/T2', '第1・第2ターミナル': ' T1/T2', '第3ターミナル': ' T3',
    '羽田空港第1ターミナル': 'Haneda Airport T1', '羽田空港第2ターミナル': 'Haneda Airport T2', '羽田空港第3ターミナル': 'Haneda Airport T3',
    'エアポート快特': ' Airport Limited Express', 'エアポート急行': ' Airport Express', '快特': ' Limited Express', 'ターミナル': ' Terminal',
    '羽田空港': 'Haneda Airport', '成田空港': 'Narita Airport', '空港第2ビル': 'Narita Airport T2',
    '浜松町': 'Hamamatsucho', '東京': 'Tokyo', '品川': 'Shinagawa', '新橋': 'Shimbashi', '有楽町': 'Yurakucho',
    '秋葉原': 'Akihabara', '上野': 'Ueno', '日暮里': 'Nippori', '池袋': 'Ikebukuro', '新宿': 'Shinjuku', '渋谷': 'Shibuya',
    '大崎': 'Osaki', '恵比寿': 'Ebisu', '目黒': 'Meguro', '五反田': 'Gotanda', '田町': 'Tamachi', '神田': 'Kanda',
    '大手町': 'Otemachi', '銀座': 'Ginza', '赤坂見附': 'Akasaka-mitsuke', '霞ケ関': 'Kasumigaseki', '表参道': 'Omotesando',
    '赤羽': 'Akabane', '大宮': 'Omiya', '浦和': 'Urawa', '川口': 'Kawaguchi', '和光市': 'Wakoshi', '朝霞台': 'Asakadai',
    '志木': 'Shiki', 'ふじみ野': 'Fujimino', '川越市': 'Kawagoeshi', '本川越': 'Hon-Kawagoe', '川越': 'Kawagoe',
    '坂戸': 'Sakado', '所沢': 'Tokorozawa', '狭山': 'Sayama', '入間': 'Iruma', '八千代': 'Yachiyo', '宇都宮': 'Utsunomiya',
    '小山': 'Oyama', '栃木': 'Tochigi', '真岡': 'Moka', '浜松': 'Hamamatsu', '豊橋': 'Toyohashi', '静岡': 'Shizuoka',
    '名古屋': 'Nagoya', '新横浜': 'Shin-Yokohama', '横浜': 'Yokohama', '川崎': 'Kawasaki', '蒲田': 'Kamata',
    '天空橋': 'Tenkubashi', '大井町': 'Oimachi', '天王洲アイル': 'Tennozu Isle', '大井競馬場前': 'Oi Keibajo-mae',
    '流通センター': 'Ryutsu Center', '昭和島': 'Showajima', '整備場': 'Seibijo', '新木場': 'Shin-Kiba', '大崎駅': 'Osaki Station',
    // Keikyu airport line, Yamanote, Seibu Shinjuku and Tobu Tojo line stations
    '泉岳寺': 'Sengakuji', '穴守稲荷': 'Anamori-inari', '大鳥居': 'Otorii', '糀谷': 'Kojiya', '京急蒲田': 'Keikyu Kamata',
    '京急川崎': 'Keikyu Kawasaki', '北品川': 'Kita-Shinagawa', '高輪ゲートウェイ': 'Takanawa Gateway', '原宿': 'Harajuku',
    '代々木': 'Yoyogi', '新大久保': 'Shin-Okubo', '高田馬場': 'Takadanobaba', '目白': 'Mejiro', '大塚': 'Otsuka', '巣鴨': 'Sugamo',
    '駒込': 'Komagome', '田端': 'Tabata', '西日暮里': 'Nishi-Nippori', '鶯谷': 'Uguisudani', '御徒町': 'Okachimachi',
    '西武新宿線': 'Seibu Shinjuku Line', '西武新宿': 'Seibu-Shinjuku', '下落合': 'Shimo-Ochiai', '中井': 'Nakai', '新井薬師前': 'Araiyakushi-mae', '沼袋': 'Numabukuro',
    '野方': 'Nogata', '都立家政': 'Toritsu-Kasei', '鷺ノ宮': 'Saginomiya', '下井草': 'Shimo-Igusa', '井荻': 'Iogi',
    '上井草': 'Kami-Igusa', '上石神井': 'Kami-Shakujii', '武蔵関': 'Musashi-Seki', '東伏見': 'Higashi-Fushimi',
    '西武柳沢': 'Seibu-Yagisawa', '田無': 'Tanashi', '花小金井': 'Hana-Koganei', '小平': 'Kodaira', '久米川': 'Kumegawa',
    '東村山': 'Higashi-Murayama', '航空公園': 'Kokukoen', '新所沢': 'Shin-Tokorozawa', '入曽': 'Iriso', '狭山市': 'Sayama-shi',
    '新狭山': 'Shin-Sayama', '南大塚': 'Minami-Otsuka', '高田馬場駅': 'Takadanobaba Station', '北池袋': 'Kita-Ikebukuro',
    '下板橋': 'Shimo-Itabashi', '大山': 'Oyama', '中板橋': 'Naka-Itabashi', 'ときわ台': 'Tokiwadai', '上板橋': 'Kami-Itabashi',
    '東武練馬': 'Tobu-Nerima', '下赤塚': 'Shimo-Akatsuka', '成増': 'Narimasu', '朝霞': 'Asaka', '柳瀬川': 'Yanasegawa',
    'みずほ台': 'Mizuhodai', '鶴瀬': 'Tsuruse', '上福岡': 'Kami-Fukuoka', '新河岸': 'Shingashi',
    '的場': 'Matoba', '笠幡': 'Kasahata', '武蔵高萩': 'Musashi-Takahagi', '高麗川': 'Komagawa', '南古谷': 'Minami-Furuya',
    'モノレール': 'Monorail', '駅': ' Station', '線': ' Line', '口': ' Exit', '市': '-shi',
  };
  const keys = Object.keys(WORDS).sort((a, b) => b.length - a.length);

  function toEnglish(text) {
    if (!text) return '';
    let out = String(text).normalize('NFKC') // full-width ＪＲ / １ -> JR / 1
      .replace(/\((東京都|埼玉県|千葉県|神奈川県|栃木県|群馬県|茨城県|静岡県|愛知県|大阪府|京都府)\)/g, ''); // drop "(Saitama Pref.)" style labels
    keys.forEach((k) => { out = out.split(k).join(WORDS[k]); });
    return out.replace(/(\S)\(/g, '$1 (').replace(/\s+/g, ' ').replace(/\s+\)/g, ')').trim();
  }

  return { toEnglish };
})();
