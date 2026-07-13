insert into document_types (name, applies_to, is_required, sequence_order) values
  ('Passport', 'Student', true, 10),
  ('PAN Card', 'Student', true, 20),
  ('Aadhaar Card', 'Student', true, 30),
  ('Admission Letter', 'Student', true, 40),
  ('Academic Transcripts', 'Student', true, 50),
  ('English Test Score (IELTS/TOEFL/GRE)', 'Student', false, 60),
  ('Co-applicant PAN Card', 'Co-applicant', true, 70),
  ('Co-applicant Income Proof', 'Co-applicant', true, 80),
  ('Co-applicant Bank Statements', 'Co-applicant', true, 90),
  ('Property Documents', 'Co-applicant', false, 100)
on conflict (name) do nothing;
