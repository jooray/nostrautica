/**
 * 20 personas for a fictional cypherpunk / tech-adjacent conference ("Reclaim").
 *
 * Each persona carries:
 *  - id, name
 *  - profile: { about, skills[], looking_for }  (mirrors AttendeeProfile)
 *  - transcript: ~120-180-word intro-video transcript in their own voice
 *  - ai_profile: { summary, skills, interests, offers, seeks }  (mirrors profile.ts
 *    output — what the REAL matcher sees; scoring.ts reads exactly these fields)
 *
 * Ground truth (STRONG/MEDIUM/WEAK intended pairings) lives ONLY in gold-pairs.json
 * and is NEVER shown to the scoring models.
 */

export const EVENT = {
  title: "Reclaim — a cypherpunk & self-sovereignty unconference",
  summary:
    "A three-day gathering for privacy engineers, freedom-tech builders, journalists, artists and organizers who want to ship tools that put people back in control of their money, data and identity. Half talks, half hallway. People come to find collaborators, co-founders, hires, funders, and stories.",
  hashtags: ["cypherpunk", "privacy", "bitcoin", "nostr", "freedomtech", "opensource"],
};

export const PERSONAS = [
  {
    id: "p01",
    name: "Mara Okafor",
    profile: {
      about:
        "Non-technical founder. Spent 8 years running mutual-aid logistics; now building a censorship-resistant payments app for grassroots organizers. Business + ops, no engineering.",
      skills: ["fundraising", "operations", "community organizing", "product vision", "grant writing"],
      looking_for:
        "A senior Rust engineer to be my technical co-founder. I have the mission, the users and some funding — I need someone who can actually build it.",
    },
    transcript:
      "Hi, I'm Mara. So, I'm not an engineer — I'll say that upfront so nobody's surprised later. For eight years I ran logistics for mutual-aid networks, moving money and supplies to people the banking system basically hates. And every single time, the payment rails were the weak point. Accounts frozen, transfers reversed, organizers deplatformed. So I'm building an app that lets these groups take donations that can't be shut off. I've got early users lined up, I've got a bit of grant funding, I've written the whole product spec. What I do not have is a technical co-founder. I need a serious engineer — honestly, probably Rust, given what this has to do — who wants a mission and not just a paycheck. I can carry fundraising, ops, all of it. I just can't write the code. Come find me if that's you.",
    ai_profile: {
      summary:
        "Mara is a mission-driven, non-technical founder with a background in mutual-aid logistics, building a censorship-resistant payments app for grassroots organizers. She has users and some funding but no engineering capacity.",
      skills: ["fundraising", "operations", "community organizing", "product vision", "grant writing"],
      interests: ["censorship resistance", "mutual aid", "grassroots payments", "financial inclusion"],
      offers: ["a funded mission-driven startup", "user access", "fundraising and ops leadership", "product direction"],
      seeks: ["a senior Rust engineer as technical co-founder", "someone who wants a mission over a paycheck"],
    },
  },
  {
    id: "p02",
    name: "Dmitri Volkov",
    profile: {
      about:
        "Staff Rust engineer at a large fintech, quietly bored. Payments infra, cryptography-adjacent, ship-it type. Want to work on something that matters.",
      skills: ["Rust", "distributed systems", "payments infrastructure", "cryptographic protocols", "systems architecture"],
      looking_for:
        "A mission I can pour myself into. I'm a builder without a cause right now. Open to co-founding if the founder is serious and the problem is real.",
    },
    transcript:
      "Yeah so I'm Dmitri, I write Rust for a big fintech, been there four years. It pays extremely well and I am extremely bored. Like, I optimize latency on transaction batching for a company whose mission is, uh, quarterly earnings. I'm good though — I've built payment systems that move real money at scale, I know the crypto side, I can architect the whole backend myself. The thing is I keep reading about people building freedom tech, actual tools for people who need them, and I'm sitting in a beige office tuning a system nobody loves. I don't want to start something from a blank page alone — I'm an engineer, not a hustler. But if there's a founder here who's got the mission and the users and just needs someone who can genuinely build the hard backend, that's the conversation I came for.",
    ai_profile: {
      summary:
        "Dmitri is a staff-level Rust engineer at a large fintech, expert in payments infrastructure and cryptographic protocols, but disillusioned with corporate work. He wants to join a mission-driven project and is open to co-founding.",
      skills: ["Rust", "distributed systems", "payments infrastructure", "cryptographic protocols", "systems architecture"],
      interests: ["freedom tech", "privacy", "meaningful engineering", "financial systems"],
      offers: ["senior Rust backend engineering", "payments systems architecture", "ability to build hard infra solo"],
      seeks: ["a mission-driven founder with users and funding", "a real problem worth solving", "a co-founder role"],
    },
  },
  {
    id: "p03",
    name: "Priya Nadar",
    profile: {
      about:
        "Documentary filmmaker focused on surveillance and dissent. Two films on festival circuits. Looking for untold stories and people brave enough to tell them.",
      skills: ["documentary filmmaking", "interviewing", "story development", "video editing", "visual storytelling"],
      looking_for:
        "Sources and subjects with real, high-stakes stories about fighting surveillance or state overreach — and people who can help protect them legally.",
    },
    transcript:
      "I'm Priya, I make documentaries. My last two were about people who stood up to surveillance regimes and what it cost them. I'm at Reclaim because this room is full of exactly the stories I want to tell — people building tools to resist the same systems I film. But here's my honest problem: whenever I find someone with a real story, a whistleblower, someone who's actually risked something, the first thing they need isn't a camera, it's protection. They need to know they won't get burned. So I'm looking for two things. One, subjects — people carrying stories that deserve to be seen. And two, I really want to meet lawyers or advocates who work with sources, because I can't in good conscience put someone on screen without a way to keep them safe. If either of those is you, let's talk.",
    ai_profile: {
      summary:
        "Priya is an award-circuit documentary filmmaker specializing in surveillance and dissent. She seeks high-stakes untold stories and, crucially, legal allies who can protect vulnerable sources before she films them.",
      skills: ["documentary filmmaking", "interviewing", "story development", "video editing", "visual storytelling"],
      interests: ["surveillance", "dissent", "press freedom", "human rights", "source protection"],
      offers: ["a platform to tell high-stakes stories", "filmmaking and visual storytelling", "festival reach"],
      seeks: ["whistleblowers and subjects with real stories", "lawyers or advocates who protect sources"],
    },
  },
  {
    id: "p04",
    name: "Gideon Frei",
    profile: {
      about:
        "Human-rights lawyer specializing in whistleblower and source protection. Ran defense for several high-profile leakers. Believe stories need to be told safely.",
      skills: ["source-protection law", "whistleblower defense", "legal risk assessment", "digital-security counseling", "litigation"],
      looking_for:
        "Journalists and filmmakers who want to tell whistleblower stories responsibly — I can help keep their sources out of prison. Also cases that matter.",
    },
    transcript:
      "Gideon here. I'm a lawyer — specifically I defend whistleblowers and protect journalistic sources, which is a fancy way of saying I spend my life trying to keep brave people out of a cell. I've run defense for leakers you've read about, and the pattern is always the same: someone has a story the public needs, and the moment it goes public, the machine comes for them. What I've realized is that the protection has to start before publication, not after. So I actually love meeting the people who tell these stories — journalists, documentary makers — because if they loop me in early, I can build a shield around a source instead of a defense after the arrest. I've got stories, too, cases I wish someone would film. If you make things that put whistleblowers on the record, you and I should absolutely be talking. I can be the reason your source sleeps at night.",
    ai_profile: {
      summary:
        "Gideon is a human-rights lawyer specializing in whistleblower defense and source protection, having defended high-profile leakers. He wants to partner with storytellers early so sources are protected before, not after, publication.",
      skills: ["source-protection law", "whistleblower defense", "legal risk assessment", "digital-security counseling", "litigation"],
      interests: ["press freedom", "whistleblowers", "civil liberties", "digital security"],
      offers: ["legal protection for sources", "whistleblower defense", "cases worth telling", "early legal risk counseling"],
      seeks: ["journalists and filmmakers telling whistleblower stories", "cases that matter"],
    },
  },
  {
    id: "p05",
    name: "Tomás Reyes",
    profile: {
      about:
        "Drummer. Play in a couple of projects, none serious. Day job is DevOps. Want to start a real band with people from this scene.",
      skills: ["drums", "percussion", "live performance", "DevOps", "Linux sysadmin"],
      looking_for:
        "Musicians to start a band — especially a bassist. I keep time, I just need people to lock in with. Bonus if you're also in tech.",
    },
    transcript:
      "Hey, Tomás. By day I do DevOps, keep servers alive, nothing exciting. But the reason I'm actually excited to be here is music. I'm a drummer — been playing since I was a kid — and I've been in a few half-hearted projects that never went anywhere because you can never find people who'll commit. This crowd is my people though: nerds who also secretly shred. What a band lives or dies on is the rhythm section, and a drummer without a bassist is just a guy hitting things loudly. So mostly I'm hunting for a bassist — somebody who wants to actually lock in a groove and, you know, form a real band, not just jam once and vanish. If you play bass, or honestly any instrument and you're serious about it, come grab me. I'll probably be the one air-drumming during the talks.",
    ai_profile: {
      summary:
        "Tomás is a lifelong drummer working in DevOps by day. He wants to form a serious band from the tech scene and is specifically hunting for a bassist to anchor a rhythm section.",
      skills: ["drums", "percussion", "live performance", "DevOps", "Linux sysadmin"],
      interests: ["music", "live performance", "band culture", "self-hosting"],
      offers: ["drumming and rhythm", "a committed bandmate", "DevOps know-how"],
      seeks: ["a bassist", "serious musicians to form a band", "people in tech who also play"],
    },
  },
  {
    id: "p06",
    name: "Sunny Kaur",
    profile: {
      about:
        "Bassist and synth tinkerer. Software person too (embedded firmware). Just moved to town, don't know any musicians here yet.",
      skills: ["bass guitar", "synthesizers", "music production", "embedded firmware", "C programming"],
      looking_for:
        "A band to join. I play bass and I'm reliable. Would love bandmates who are also into tech so we actually speak the same language.",
    },
    transcript:
      "Hi, I'm Sunny. So I do embedded firmware for a living — tiny chips, C code, that whole world — but the part of me that's alive is the part that plays bass. I moved here three months ago and I know exactly zero musicians in this city, which is depressing because playing alone in your apartment gets old fast. I'm a bassist first, I mess with synths too, and I'm honestly just a reliable person — I show up to practice, I learn the songs, I don't flake. What I want is simple: a band. Ideally with people who are also technical, because I find we just click better, we understand each other's schedules and obsessions. A drummer especially would be a dream, because bass and drums together is where it all starts. If you're building something musical and need a low end, that's me. Please rescue me from my apartment.",
    ai_profile: {
      summary:
        "Sunny is a reliable bassist and synth tinkerer who works in embedded firmware. New in town and knowing no local musicians, she wants to join or form a band, ideally with fellow technical people.",
      skills: ["bass guitar", "synthesizers", "music production", "embedded firmware", "C programming"],
      interests: ["music", "synthesizers", "embedded hardware", "band culture"],
      offers: ["bass and low end", "reliability and commitment", "synth and production skills"],
      seeks: ["a band to join", "a drummer to play with", "technical bandmates"],
    },
  },
  {
    id: "p07",
    name: "Elena Marchetti",
    profile: {
      about:
        "Applied cryptographer. Zero-knowledge proofs, MPC. Academic turning practical. Great at protocols, hopeless at UI. Want my work to reach real people.",
      skills: ["zero-knowledge proofs", "cryptographic protocol design", "MPC", "formal verification", "academic research"],
      looking_for:
        "A product designer / UX person who can turn my cryptography into something a normal human can actually use. My demos scare people.",
    },
    transcript:
      "Elena. I'm a cryptographer — zero-knowledge proofs, secure multiparty computation, the deep end. I spent a decade in academia proving things are possible and now I want them to be, you know, actually used by humans. Here's my confession: I am spectacularly bad at making things usable. My reference implementation has a command line that requires reading a nine-page PDF, and people's eyes glaze over the moment I open my mouth. The math is sound, the privacy guarantees are real, but the experience is hostile. What I desperately need is a designer — someone who lives and breathes product and UX — who can take this genuinely powerful cryptography and wrap it in something a normal person can tap through without fear. I'll happily explain the protocols in as much or as little depth as you want. I just can't be the one drawing the screens. Find me if you make scary things friendly.",
    ai_profile: {
      summary:
        "Elena is an applied cryptographer (ZK proofs, MPC) transitioning from academia to practice. Her protocols are powerful but her implementations are unusable; she urgently seeks a product designer to make her cryptography approachable.",
      skills: ["zero-knowledge proofs", "cryptographic protocol design", "MPC", "formal verification", "academic research"],
      interests: ["privacy technology", "applied cryptography", "making crypto usable"],
      offers: ["cutting-edge cryptographic protocols", "ZK and MPC expertise", "rigorous privacy guarantees"],
      seeks: ["a product designer / UX person", "someone to make her cryptography usable by normal people"],
    },
  },
  {
    id: "p08",
    name: "Jonah Bright",
    profile: {
      about:
        "Product designer obsessed with making hard technical things feel simple. Ex-consumer apps, tired of ad tech, want to design something meaningful and private.",
      skills: ["product design", "UX research", "interaction design", "prototyping", "design systems"],
      looking_for:
        "A brilliant technical partner with real substance — cryptography, security — whose work is powerful but unusable. I make scary tech feel human.",
    },
    transcript:
      "I'm Jonah, I'm a product designer. For years I made slick consumer apps whose actual job was to harvest attention and sell ads, and I got very good at it and very sick of it. What I'm good at is taking something intimidating and complicated and making it feel obvious — the tap-tap-done feeling. And the thing is, the most intimidating, complicated, important tech in the world right now is privacy and cryptography, and most of it has, let's be honest, atrocious user experience. Powerful engines, terrible dashboards. That's my dream collaboration: find someone whose technology is genuinely deep — a cryptographer, a security researcher — whose demo makes normal people flinch, and be the person who turns it into something they'd actually want to use. I don't need to understand every equation. I need to understand the human on the other side. If your tech is brilliant and your UI is a war crime, come talk to me.",
    ai_profile: {
      summary:
        "Jonah is a product designer who left ad-tech to work on meaningful, private products. He specializes in making intimidating technical tools feel simple and seeks a deep technical partner whose powerful work suffers from poor usability.",
      skills: ["product design", "UX research", "interaction design", "prototyping", "design systems"],
      interests: ["privacy", "usable security", "ethical technology", "consumer product design"],
      offers: ["turning complex tech into simple UX", "product and interaction design", "user research"],
      seeks: ["a deep technical partner in cryptography or security", "powerful tech that needs usability"],
    },
  },
  {
    id: "p09",
    name: "Bao Nguyen",
    profile: {
      about:
        "Investigative journalist covering financial crime and sanctions evasion. Great at documents, terrible at data. Drowning in leaked spreadsheets.",
      skills: ["investigative journalism", "financial forensics", "FOIA", "narrative writing", "interviewing"],
      looking_for:
        "A data scientist who can help me find the story inside huge leaked datasets. I have the documents; I can't make them talk.",
    },
    transcript:
      "Bao, investigative journalist. I chase financial crime — sanctions evasion, shell companies, dirty money moving through clean banks. And I'm sitting on the biggest leak of my career and I am completely stuck, because it's forty gigabytes of transaction records and I am, fundamentally, a words person. I can read a document, I can work a source, I can write the hell out of a story. But give me a database with ten million rows and I stare at it like it's written in a language I failed in school. I know there are patterns in there — networks, timing, the shape of the fraud — I just can't extract them. What I need is a data scientist who gets excited by exactly the thing that terrifies me: making a giant, ugly dataset confess. You bring the analysis, I bring the story and the sources, and together maybe we publish something that actually matters. That's the partnership I'm hunting for.",
    ai_profile: {
      summary:
        "Bao is an investigative journalist covering financial crime and sanctions evasion, strong on documents and sources but overwhelmed by a massive leaked dataset. He seeks a data scientist to surface patterns he can turn into a story.",
      skills: ["investigative journalism", "financial forensics", "FOIA", "narrative writing", "interviewing"],
      interests: ["financial crime", "sanctions evasion", "accountability journalism", "leaks"],
      offers: ["a major leaked dataset and story", "source access", "narrative and reporting"],
      seeks: ["a data scientist to analyze large leaked datasets", "help finding patterns in transaction data"],
    },
  },
  {
    id: "p10",
    name: "Ingrid Solberg",
    profile: {
      about:
        "Data scientist / ML engineer. Love messy real-world data and graph analysis. Between jobs, want a project with meaning, not another ad-click model.",
      skills: ["data science", "graph analysis", "anomaly detection", "Python", "large-scale data pipelines"],
      looking_for:
        "A high-impact dataset and a partner who has the domain knowledge I lack. I can make huge messy data reveal its structure.",
    },
    transcript:
      "Hi, Ingrid. I'm a data scientist — really an ML engineer who's happiest elbow-deep in horrible, messy, real-world data. Graph analysis, anomaly detection, finding the one weird cluster in a billion rows: that's my whole personality. I just left a job predicting which ad you'd click, which paid great and rotted my soul a little. So I'm here looking for a dataset that actually matters and, honestly, a partner who knows a domain I don't — because I can find the pattern but I often can't tell you what it means without someone who lives in that world. Financial data, network data, leaked records, whatever — if it's big and ugly and hides something important, I want it. Pair me with someone who has the story but not the skills to pull it out of the numbers, and I'll happily be the person who makes the data talk. That combination is basically my dream.",
    ai_profile: {
      summary:
        "Ingrid is a data scientist and ML engineer who thrives on messy, large-scale real-world data, graph analysis and anomaly detection. Between jobs and craving meaningful work, she seeks a high-impact dataset and a domain-expert partner.",
      skills: ["data science", "graph analysis", "anomaly detection", "Python", "large-scale data pipelines"],
      interests: ["messy real-world data", "graph analysis", "meaningful ML", "investigations"],
      offers: ["turning huge messy datasets into structure", "anomaly and pattern detection", "ML engineering"],
      seeks: ["a high-impact dataset", "a domain-expert partner who has the story but not the analysis skills"],
    },
  },
  {
    id: "p11",
    name: "Casimir Wolff",
    profile: {
      about:
        "Bitcoin core-adjacent dev and educator. Run workshops teaching self-custody. Strong on protocol, want to reach non-technical people better.",
      skills: ["Bitcoin protocol", "Lightning Network", "technical education", "workshop facilitation", "wallet security"],
      looking_for:
        "Community organizers and educators to help me bring self-custody to people who aren't already crypto nerds.",
    },
    transcript:
      "I'm Casimir. I've been in Bitcoin a long time — I hack on the protocol side, Lightning, wallet security, and I run workshops teaching people to hold their own keys. Here's my frustration: I'm great at teaching people who already show up to a Bitcoin meetup, which is, let's be honest, the same forty guys. The people who actually need financial sovereignty — folks the banks fail, communities running on cash and trust — those people never walk into my workshop, because it's full of jargon and men in Bitcoin t-shirts. So I'm looking for organizers, people who already have the trust of real communities, who could help me translate self-custody into something normal humans want. I bring the deep technical chops and the curriculum. I need someone who knows how to actually reach people and build community around it. If you organize, if you have a community that the financial system has failed, let's figure out how to serve them together.",
    ai_profile: {
      summary:
        "Casimir is a Bitcoin protocol developer and educator who runs self-custody workshops but only reaches existing crypto insiders. He wants to partner with community organizers to bring financial sovereignty to underserved, non-technical people.",
      skills: ["Bitcoin protocol", "Lightning Network", "technical education", "workshop facilitation", "wallet security"],
      interests: ["financial sovereignty", "self-custody", "bitcoin education", "reaching non-technical users"],
      offers: ["deep bitcoin and self-custody expertise", "workshop curriculum", "technical education"],
      seeks: ["community organizers and educators", "help reaching non-technical, underserved communities"],
    },
  },
  {
    id: "p12",
    name: "Fatima Rahimi",
    profile: {
      about:
        "Community organizer with refugee and immigrant networks. Deep trust, no tech. People I work with get shut out of banking constantly.",
      skills: ["community organizing", "trust building", "translation", "grassroots education", "event facilitation"],
      looking_for:
        "Technical people who can teach my communities practical tools — especially around money and identity — in a way that isn't intimidating.",
    },
    transcript:
      "Salaam, I'm Fatima. I organize with refugee and immigrant communities — I've spent years building trust with people who've been burned by every institution you can name. And the thing that comes up over and over is money: they get locked out of bank accounts, remittances get frozen, they carry cash and get robbed, they can't prove who they are to any system. I know in my bones that the tools to fix this exist somewhere in a room like this. But the people who build them speak a language my communities don't, and frankly the whole crypto world looks scary and scammy from the outside, for good reason. What I have is trust — real, hard-won trust — and access to people who genuinely need this. What I don't have is the technical side. I'm looking for someone patient and technical who wants to actually serve these communities with me, not lecture them. Teach with me, not at us.",
    ai_profile: {
      summary:
        "Fatima is a community organizer with deep, hard-won trust in refugee and immigrant networks whose members are routinely shut out of banking and identity systems. She seeks patient technical partners to bring practical money and identity tools to her communities.",
      skills: ["community organizing", "trust building", "translation", "grassroots education", "event facilitation"],
      interests: ["refugee rights", "financial inclusion", "identity", "grassroots empowerment"],
      offers: ["deep community trust and access", "organizing and facilitation", "translation and grassroots reach"],
      seeks: ["patient technical partners", "people to teach money and identity tools to underserved communities"],
    },
  },
  {
    id: "p13",
    name: "Kenji Watanabe",
    profile: {
      about:
        "Hardware hacker. Build secure elements, tamper-evident devices, cold-storage gadgets. Solder-fume enthusiast. Weak on software UX and firmware polish.",
      skills: ["hardware design", "secure elements", "PCB design", "tamper resistance", "electronics prototyping"],
      looking_for:
        "A firmware/software engineer to pair with on secure hardware — I build the boards, I need someone to make the code sing.",
    },
    transcript:
      "Kenji. I build hardware — secure elements, tamper-evident enclosures, little cold-storage devices you can trust with your keys. I love the physical layer: the board, the epoxy, the mesh that fries the chip if you drill into it. That part I've got completely handled. Where I fall down is the software. I can write firmware that technically works, but it's ugly, it's fragile, and the moment it needs to be robust and clean I'm out of my depth. A secure device is only as good as the code running on it, and right now my boards deserve better firmware than I can give them. So I want to find a firmware or embedded-software engineer who gets excited about hardware — someone who wants to make the code as bulletproof as the enclosure. I bring the silicon and the solder; you bring the software craftsmanship. Together we could actually ship a device people trust with real money.",
    ai_profile: {
      summary:
        "Kenji is a hardware hacker who designs secure elements, tamper-evident devices and cold-storage gadgets. Strong on physical security but weak on software, he seeks a firmware/embedded engineer to make his devices' code as robust as their hardware.",
      skills: ["hardware design", "secure elements", "PCB design", "tamper resistance", "electronics prototyping"],
      interests: ["hardware security", "cold storage", "tamper resistance", "trusted devices"],
      offers: ["secure hardware design", "PCB and tamper-resistant enclosures", "physical-layer security"],
      seeks: ["a firmware / embedded-software engineer", "someone to make secure-device code robust"],
    },
  },
  {
    id: "p14",
    name: "Rosa Delgado",
    profile: {
      about:
        "Embedded/firmware engineer who loves clean, defensive code close to metal. Currently on web stuff and miserable. Want to work on hardware that matters.",
      skills: ["embedded firmware", "C and Rust", "defensive programming", "real-time systems", "cryptographic implementations"],
      looking_for:
        "A hardware person building secure or interesting devices who needs firmware that's actually solid. I want to get back to metal.",
    },
    transcript:
      "I'm Rosa. I'm a firmware engineer — my happy place is a few kilobytes of RAM, a datasheet, and code that has to be perfect because there's no room for it not to be. Defensive, real-time, close to the metal, ideally touching crypto. The tragedy of my current situation is that I've been stuck writing web dashboards for a year and every day a small part of me dies. I miss hardware. I miss the constraint. What I'm looking for is someone who builds actual physical devices — secure hardware, cold storage, weird trustworthy gadgets — who has great boards but firmware that's, let's say, aspirational. That's the gap I fill. I write the tight, robust, defensible code that makes a secure device actually secure and not just secure-looking. If you're a hardware person and your firmware embarrasses you a little, we should talk, because that's exactly the code I want to be writing.",
    ai_profile: {
      summary:
        "Rosa is an embedded/firmware engineer who loves tight, defensive, close-to-metal code touching cryptography, but is stuck doing web work. She wants to partner with a hardware builder who needs solid firmware for secure devices.",
      skills: ["embedded firmware", "C and Rust", "defensive programming", "real-time systems", "cryptographic implementations"],
      interests: ["embedded systems", "hardware security", "low-level programming", "cryptographic implementations"],
      offers: ["robust defensive firmware", "real-time embedded engineering", "secure crypto implementations"],
      seeks: ["a hardware builder making secure or interesting devices", "firmware work back on the metal"],
    },
  },
  {
    id: "p15",
    name: "Aleksy Nowak",
    profile: {
      about:
        "Privacy researcher and academic. Study metadata leakage and traffic analysis. Publish papers few read. Want impact beyond citations.",
      skills: ["privacy research", "traffic analysis", "anonymity systems", "academic writing", "threat modeling"],
      looking_for:
        "Builders who'll turn my anonymity research into shipped tools, and journalists who need threat models for protecting sources.",
    },
    transcript:
      "Aleksy, privacy researcher. I study how you get deanonymized even when you think you're safe — metadata, traffic patterns, the exhaust that leaks who you are. I publish papers, they get cited by twelve other researchers, and meanwhile the people who'd actually benefit from knowing this stuff — activists, journalists, their sources — never see it. That's my midlife crisis, basically: I want impact, not citations. Two kinds of people would make my week. One, builders who'll take my findings and turn them into something real — a tool, a default, a fix in a protocol. Two, journalists or people who protect sources, because I can build them a threat model that actually matches how real adversaries deanonymize people, instead of the folk wisdom they're using now. I know the attacks cold. I just need people who'll act on what I know. If that's you, please, save me from another lonely conference paper.",
    ai_profile: {
      summary:
        "Aleksy is a privacy researcher studying metadata leakage, traffic analysis and deanonymization, frustrated that his academic work never reaches the people it could help. He seeks builders to ship his findings and journalists who need realistic threat models.",
      skills: ["privacy research", "traffic analysis", "anonymity systems", "academic writing", "threat modeling"],
      interests: ["anonymity", "metadata privacy", "traffic analysis", "protecting activists and sources"],
      offers: ["deep anonymity and deanonymization expertise", "realistic threat models", "protocol privacy analysis"],
      seeks: ["builders to turn research into shipped tools", "journalists needing source-protection threat models"],
    },
  },
  {
    id: "p16",
    name: "Yusuf Demir",
    profile: {
      about:
        "Growth and go-to-market person for open-source and privacy startups. Made two small tools reach big audiences. Marketing without the sleaze.",
      skills: ["growth marketing", "go-to-market strategy", "developer relations", "content strategy", "community building"],
      looking_for:
        "A great privacy or freedom-tech product that nobody's heard of. I make good tools famous without being gross about it.",
    },
    transcript:
      "Hey, I'm Yusuf. I do growth — go-to-market, dev rel, getting good products in front of the people who need them. And before anyone flinches: I'm not a growth-hacker-dark-patterns guy. I've taken two open-source privacy tools from nobody's-heard-of-it to actually-used-by-a-lot-of-people, honestly, without tricking anyone. The problem in this world is that the best freedom tech is often built by brilliant engineers who think marketing is beneath them, so their amazing tool has nine users. That's tragic and it's fixable. I'm looking for a team with a genuinely great privacy or freedom-tech product and zero distribution — you built the thing, it works, and nobody knows. That's my favorite puzzle. I'll figure out the positioning, the narrative, the channels, the launch. You keep building. If your product is great and invisible, I'm the person who fixes the invisible part.",
    ai_profile: {
      summary:
        "Yusuf is a growth and go-to-market specialist for open-source and privacy startups, having scaled two tools ethically. He seeks a strong but undistributed freedom-tech product whose team lacks marketing capacity.",
      skills: ["growth marketing", "go-to-market strategy", "developer relations", "content strategy", "community building"],
      interests: ["open-source distribution", "privacy tools", "ethical marketing", "developer communities"],
      offers: ["go-to-market and growth", "developer relations", "ethical distribution and positioning"],
      seeks: ["a great privacy/freedom-tech product with no distribution", "an engineering team lacking marketing"],
    },
  },
  {
    id: "p17",
    name: "Nadia Petrov",
    profile: {
      about:
        "Angel investor and ex-founder. Write small checks into freedom tech. Look for mission-aligned teams early. Also mentor first-time founders.",
      skills: ["early-stage investing", "startup mentorship", "fundraising strategy", "network access", "founder coaching"],
      looking_for:
        "Early mission-driven freedom-tech teams to fund and mentor — especially first-time founders solving real censorship or privacy problems.",
    },
    transcript:
      "I'm Nadia. I sold a company a while back and now I write small angel checks, mostly into freedom tech — privacy, censorship resistance, tools that give people control. I also mentor first-time founders, because I made every mistake in the book and I'd rather you make new ones. What I look for is not a polished pitch — it's a real problem and a team that clearly can't not work on it. I'm allergic to founders chasing whatever's hot; I want the person who's been obsessed with censorship-resistant payments or private identity for years. So if you're early — pre-seed, maybe just an idea and a prototype and a burning conviction — and you're solving an actual privacy or censorship problem, come find me. Worst case I give you an hour of blunt advice. Best case I write a check and open my network. First-time founders especially: don't be shy, that's exactly who I'm here for.",
    ai_profile: {
      summary:
        "Nadia is an angel investor and ex-founder who writes small early checks into freedom tech and mentors first-time founders. She seeks mission-obsessed early teams solving real censorship or privacy problems.",
      skills: ["early-stage investing", "startup mentorship", "fundraising strategy", "network access", "founder coaching"],
      interests: ["freedom tech", "censorship resistance", "early-stage startups", "founder mentorship"],
      offers: ["angel funding", "founder mentorship and coaching", "network access", "fundraising strategy"],
      seeks: ["early mission-driven freedom-tech teams", "first-time founders solving privacy or censorship problems"],
    },
  },
  {
    id: "p18",
    name: "Theo Lindqvist",
    profile: {
      about:
        "Generalist full-stack dev, hobby photographer, likes hiking and board games. Curious about privacy but not deep in it. Here to learn and meet people.",
      skills: ["full-stack development", "JavaScript", "React", "photography", "general web"],
      looking_for:
        "Honestly just to learn what this scene is about, make some friends, maybe find a side project. No strong agenda.",
    },
    transcript:
      "Hi, I'm Theo. I'm a full-stack developer — React, Node, the usual web stuff — nothing exotic. I'll be honest, I'm kind of a tourist here. I read about cypherpunk stuff, thought it sounded cool, and figured I'd come see what it's actually about. I don't have a grand mission or a startup or a cause I'm burning for. I like building things, I take photos as a hobby, I hike, I play too many board games. I guess I'm hoping to learn enough to figure out if this world is for me, meet some interesting people, and maybe stumble into a fun side project if the vibe is right. If you want to explain your thing to someone genuinely curious but not an expert, I'm a great audience. And if anyone wants to grab a hike or a game between sessions, I'm always up for that. That's about it, really — no agenda, just curiosity.",
    ai_profile: {
      summary:
        "Theo is a generalist full-stack web developer and hobby photographer with casual curiosity about the privacy scene but no strong mission. He's here to learn, make friends, and maybe find a low-stakes side project.",
      skills: ["full-stack development", "JavaScript", "React", "photography", "general web"],
      interests: ["web development", "photography", "hiking", "board games", "learning about privacy"],
      offers: ["general full-stack web help", "a curious audience", "casual collaboration"],
      seeks: ["to learn about the cypherpunk scene", "friends and casual connections", "a possible side project"],
    },
  },
  {
    id: "p19",
    name: "Halima Osei",
    profile: {
      about:
        "UX writer and plain-language specialist. Turn dense, scary security instructions into words humans understand. Believe clarity is a safety feature.",
      skills: ["UX writing", "plain-language design", "documentation", "content design", "security communication"],
      looking_for:
        "Security and privacy projects whose instructions terrify normal users. I make dangerous-sounding things clear and calm.",
    },
    transcript:
      "I'm Halima. I'm a UX writer — specifically I take the terrifying, jargon-soaked instructions that security tools throw at people and rewrite them so a normal human doesn't panic. You know the moment: an app tells you to 'securely back up your seed phrase' and shows twenty-four random words and the user just... freezes and screenshots them, which is the worst thing they could do. That failure is a writing failure, not a user failure. Clarity is a safety feature — bad words get people hacked. So I'm looking for security and privacy teams whose product is solid but whose words are a minefield. Onboarding that scares people off, error messages that make things worse, docs nobody finishes. I bring calm, clear, human language that actually changes behavior. Engineers usually hate writing this stuff and I love it, so it's a pretty natural trade. If your tool is safe but your instructions aren't, that's exactly the problem I want.",
    ai_profile: {
      summary:
        "Halima is a UX writer and plain-language specialist who rewrites dense, scary security instructions into clear, calm words, treating clarity as a safety feature. She seeks security/privacy projects whose solid tools are undermined by intimidating language.",
      skills: ["UX writing", "plain-language design", "documentation", "content design", "security communication"],
      interests: ["plain language", "usable security", "onboarding", "human-centered safety"],
      offers: ["clear plain-language writing", "security onboarding and docs", "content design that changes behavior"],
      seeks: ["security and privacy projects with intimidating instructions", "teams whose UX writing fails users"],
    },
  },
  {
    id: "p20",
    name: "Lars Andersen",
    profile: {
      about:
        "Retired network engineer, now a beekeeper. Come to conferences for the conversations. Deep old-school networking knowledge, no current projects.",
      skills: ["network engineering", "BGP", "legacy infrastructure", "beekeeping", "mentoring"],
      looking_for:
        "Good conversations and maybe to mentor younger engineers. I'm not building anything — I keep bees now. Here for the company.",
    },
    transcript:
      "Lars here. I'm mostly retired — I spent thirty-odd years as a network engineer, back when we ran the internet on BGP and prayers, and now I keep bees, which I recommend to everyone. I'm not here with a project or a pitch. At my age you come to these things for the conversation, for the young people doing wild things I only half understand. I've got a lot of scar tissue from building infrastructure that had to actually stay up, and if some younger engineer wants to sit with an old man and hear war stories or get unstuck on something gnarly, I'm delighted to do that. But mostly I'm here to listen, to be around clever people, and maybe to convince one of you that beekeeping is the real freedom tech. No agenda beyond good company and the occasional bit of hard-won advice. Come say hello, especially if you like bees.",
    ai_profile: {
      summary:
        "Lars is a semi-retired veteran network engineer turned beekeeper who attends conferences for conversation and to mentor younger engineers. He has deep legacy-networking knowledge but no active projects or strong goals.",
      skills: ["network engineering", "BGP", "legacy infrastructure", "beekeeping", "mentoring"],
      interests: ["networking history", "mentorship", "beekeeping", "good conversation"],
      offers: ["decades of networking wisdom", "mentorship and war stories", "friendly company"],
      seeks: ["good conversations", "younger engineers to mentor occasionally"],
    },
  },
];

export default PERSONAS;
