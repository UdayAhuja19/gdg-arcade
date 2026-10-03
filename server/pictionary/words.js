// Words to draw. The drawer picks one of three: one easy, one medium, one hard.
// Everything here is drawable in under a minute, has one obvious answer, and is safe on a
// projector. Multi-word answers are fine: guessers can type them with or without the space.
//
//   EASY    one object, recognisable in a few lines (balloon, pizza, snail)
//   MEDIUM  an object, animal or place that needs a detail or two (lighthouse, octopus, shawarma)
//   HARD    a scene, an action or a clever idea, still concrete enough to draw (traffic jam,
//           low battery, tug of war)
//
// Nothing abstract that can't be drawn (no "dream", "gravity", "invisible"), and no two words
// that come out as the same drawing (train and metro, rocket and spaceship).

export const EASY = [
  "apple", "banana", "balloon", "bee", "bird", "boat", "book", "bus", "cake", "camel",
  "candle", "car", "cat", "clock", "cloud", "cookie", "cow", "crown", "cupcake", "dog",
  "donut", "duck", "egg", "fish", "flower", "frog", "ghost", "guitar", "hat", "heart",
  "horse", "house", "ice cream", "key", "kite", "ladder", "moon", "mountain", "mushroom", "pizza",
  "rainbow", "robot", "rocket", "shoe", "snake", "snowman", "spider", "star", "sun", "sword",
  "tree", "train", "umbrella", "whale", "pumpkin", "tent", "envelope", "backpack", "bell", "bone",
  "butterfly", "carrot", "cheese", "drum", "hot dog", "laptop", "penguin", "palm tree", "lollipop", "popcorn",
  "snail", "airplane", "pyramid", "burger", "fries", "teddy bear", "toothbrush", "sunglasses", "phone", "crab",
  "trophy", "pineapple", "watermelon", "strawberry", "rabbit", "bed", "pencil", "sock", "bridge", "lightbulb",
];

export const MEDIUM = [
  "anchor", "astronaut", "battery", "beach", "bicycle", "bowling", "cactus", "camera", "campfire", "castle",
  "caterpillar", "coconut", "dinosaur", "dolphin", "dragon", "elephant", "ferris wheel", "fire truck", "fireworks", "football",
  "fountain", "giraffe", "headphones", "helicopter", "hourglass", "igloo", "island", "jellyfish", "kangaroo", "keyboard",
  "lighthouse", "lightning", "lion", "magnet", "map", "mermaid", "microphone", "microscope", "octopus", "owl",
  "paint brush", "parachute", "peacock", "piano", "pirate", "rollercoaster", "sandcastle", "satellite", "scissors", "shark",
  "skateboard", "skyscraper", "ufo", "submarine", "sunflower", "ninja", "taxi", "telescope", "tornado", "traffic light",
  "treasure chest", "turtle", "unicorn", "vampire", "volcano", "waterfall", "wifi", "windmill", "wizard", "zebra",
  "shawarma", "burj khalifa", "selfie", "sushi", "moustache", "mirror", "boomerang", "flamingo", "avocado", "chopsticks",
  "toothpaste", "snow globe", "scarecrow", "knight", "hedgehog", "dentist", "magician", "puppet", "trampoline", "superhero",
];

export const HARD = [
  "aquarium", "barbecue", "black hole", "blender", "bookshelf", "bulldozer", "calculator", "chameleon", "chandelier", "cheerleader",
  "cinema", "circus", "cobweb", "constellation", "crossword", "detective", "earthquake", "eclipse", "escalator", "fingerprint",
  "fireplace", "fossil", "gingerbread man", "glacier", "goalkeeper", "hammock", "haunted house", "hide and seek", "karaoke", "lab coat",
  "lawnmower", "library", "marathon", "museum", "origami", "pickpocket", "postcard", "quicksand", "recycling", "referee",
  "shadow", "sleepwalking", "solar panel", "speed bump", "stadium", "stethoscope", "sunburn", "thunderstorm", "time machine", "treadmill",
  "tug of war", "vending machine", "virtual reality", "wedding", "wind turbine", "yoga", "zipline", "group project", "deadline", "falcon",
  "graduation", "passport", "sandstorm", "traffic jam", "low battery", "brain freeze", "camel race", "desert safari", "photobomb", "sandboarding",
  "hot air balloon", "message in a bottle", "tooth fairy", "snowball fight", "car wash", "pillow fight", "jet ski", "x ray", "wrecking ball", "bungee jump",
  "domino effect", "parallel parking", "online class", "ice skating", "magic carpet", "gold medal", "shooting star", "power outage", "pinata", "fire drill",
];

// Other answers that count as correct: what people in a UAE classroom actually type when they
// see the drawing (British spellings, local names, the everyday word). Spaces and punctuation
// don't matter, so "light bulb" already matches "lightbulb" without being listed.
export const ALIASES = {
  airplane: ["aeroplane", "plane", "jet"],
  cookie: ["biscuit"],
  donut: ["doughnut"],
  burger: ["hamburger", "cheeseburger"],
  fries: ["french fries", "chips"],
  phone: ["mobile", "mobile phone", "cellphone", "smartphone", "iphone"],
  sunglasses: ["shades"],
  rabbit: ["bunny"],
  "teddy bear": ["teddy"],
  lightbulb: ["bulb"],
  laptop: ["computer"],
  bicycle: ["bike", "cycle"],
  football: ["soccer ball", "soccer"],
  "fire truck": ["fire engine"],
  headphones: ["headset", "earphones"],
  microphone: ["mic"],
  taxi: ["cab"],
  "traffic light": ["traffic signal", "signal", "stoplight"],
  "treasure chest": ["treasure", "chest"],
  ufo: ["spaceship", "flying saucer", "alien spaceship"],
  "ferris wheel": ["ain dubai", "big wheel"],
  "paint brush": ["brush"],
  skyscraper: ["tower"],
  "burj khalifa": ["burj"],
  shawarma: ["shawerma", "shwarma", "shawurma"],
  moustache: ["mustache"],
  superhero: ["superman", "batman", "spiderman"],
  barbecue: ["bbq", "barbeque", "grill"],
  cinema: ["movie theater", "movie theatre", "movies"],
  cobweb: ["spider web", "web"],
  "gingerbread man": ["gingerbread"],
  "virtual reality": ["vr", "vr headset"],
  "low battery": ["battery low", "dead battery"],
  "camel race": ["camel racing"],
  "desert safari": ["dune bashing", "safari"],
  "bungee jump": ["bungee jumping", "bungee"],
  "ice skating": ["ice skate", "skating"],
  graduation: ["graduate"],
  "hide and seek": ["hide n seek"],
  pickpocket: ["thief"],
  wedding: ["marriage"],
  detective: ["sherlock", "sherlock holmes"],
  recycling: ["recycle"],
  sleepwalking: ["sleepwalk"],
  "snowball fight": ["snowball"],
  "gold medal": ["medal"],
  "shooting star": ["falling star", "comet"],
  "power outage": ["blackout", "power cut"],
  "domino effect": ["dominoes", "domino"],
  "online class": ["zoom class", "online lecture", "zoom call"],
  "parallel parking": ["parking"],
  "fire drill": ["fire alarm"],
  "traffic jam": ["traffic"],
  "hot air balloon": ["air balloon"],
  "magic carpet": ["flying carpet"],
};
